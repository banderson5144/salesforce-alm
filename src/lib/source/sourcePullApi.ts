/*
 * Copyright (c) 2018, salesforce.com, inc.
 * All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 * For full license text, see the LICENSE file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

// 3pp
import * as BBPromise from 'bluebird';
import * as _ from 'lodash';

// Local
import { MdRetrieveApi } from '../mdapi/mdapiRetrieveApi';
import * as SourceUtil from './sourceUtil';
import * as ManifestCreateApi from './manifestCreateApi';
import SourceMetadataMemberRetrieveHelper = require('./sourceMetadataMemberRetrieveHelper');
import * as syncCommandHelper from './syncCommandHelper';
import messagesApi = require('../messages');
import MetadataRegistry = require('./metadataRegistry');
import { BundleMetadataType } from './metadataTypeImpl/bundleMetadataType';

import * as pathUtil from './sourcePathUtil';
import { SourceWorkspaceAdapter } from './sourceWorkspaceAdapter';
import { AggregateSourceElements } from './aggregateSourceElements';
import { AsyncCreatable } from '@salesforce/kit';
import { Logger, Messages, SfdxError } from '@salesforce/core';
import { SrcStatusApi } from './srcStatusApi';
import { MaxRevision } from './MaxRevision';
import { WorkspaceElementObj } from './workspaceElement';
import * as util from 'util';
import { SourceLocations } from './sourceLocations';

export class MdapiPullApi extends AsyncCreatable<MdapiPullApi.Options> {
  public smmHelper: SourceMetadataMemberRetrieveHelper;
  public maxRevision: MaxRevision;
  public obsoleteNames: any[];
  public scratchOrg: any;
  public swa: SourceWorkspaceAdapter;
  private messages: any;
  private logger!: Logger;
  private force: any;

  public constructor(options: MdapiPullApi.Options) {
    super(options);
    this.swa = options.adapter;
    if (this.swa) {
      this.smmHelper = new SourceMetadataMemberRetrieveHelper(this.swa);
    }
    this.scratchOrg = options.org;
    this.force = this.scratchOrg.force;
    this.messages = messagesApi(this.force.config.getLocale());
    this.obsoleteNames = [];
  }

  protected async init(): Promise<void> {
    this.maxRevision = await MaxRevision.getInstance({ username: this.scratchOrg.name });
    this.logger = await Logger.child(this.constructor.name);
    if (!this.swa) {
      const options: SourceWorkspaceAdapter.Options = {
        org: this.scratchOrg,
        metadataRegistryImpl: MetadataRegistry,
        defaultPackagePath: this.force.getConfig().getAppConfig().defaultPackagePath
      };

      this.swa = await SourceWorkspaceAdapter.create(options);
      this.smmHelper = new SourceMetadataMemberRetrieveHelper(this.swa);
    }
  }

  async doPull(options) {
    // Remove this when pull has been modified to support the new mdapi wait functionality;
    if (isNaN(options.wait)) {
      options.wait = this.force.config.getConfigContent().defaultSrcWaitMinutes;
    }

    await this._checkForConflicts(options);
    const packages = await this.smmHelper.getRevisionsAsPackage(this.obsoleteNames);
    const results = await BBPromise.mapSeries(Object.keys(packages), async pkgName => {
      this.swa.packageInfoCache.setActivePackage(pkgName);
      const pkg = packages[pkgName];
      const opts = Object.assign({}, options);
      this.logger.debug('Retrieving', pkgName);
      try {
        // Create a temp directory
        opts.retrievetargetdir = await SourceUtil.createOutputDir('pull');

        // Create a manifest (package.xml).
        const manifestOptions = Object.assign({}, opts, {
          outputdir: opts.retrievetargetdir
        });
        const manifest = await this._createPackageManifest(manifestOptions, pkg);
        this.logger.debug(util.inspect(manifest, { depth: 6 }));
        let result;
        if (manifest.empty) {
          if (this.obsoleteNames.length > 0) {
            result = { fileProperties: [], success: true, status: 'Succeeded' };
          }
        } else {
          // Get default metadata retrieve options
          const retrieveOptions = Object.assign(MdRetrieveApi.getDefaultOptions(), {
            retrievetargetdir: opts.retrievetargetdir,
            unpackaged: manifest.file,
            wait: opts.wait
          });

          // Retrieve the metadata
          result = await new MdRetrieveApi(this.scratchOrg).retrieve(retrieveOptions).catch(err => err.result);
        }
        this.logger.debug(`Retrieve result:`, result);
        // Update local metadata source.
        return this._postRetrieve(result, opts);
      } finally {
        // Delete the output dir.
        await SourceUtil.cleanupOutputDir(opts.retrievetargetdir);
      }
    });
    // update the serverMaxRevision
    await this.maxRevision.setMaxRevisionCounterFromQuery();

    return results;
  }

  async _createPackageManifest(options, pkg) {
    if (pkg.isEmpty()) {
      return BBPromise.resolve({ empty: true });
    }

    if (_.isNil(options.packageXml) || !options.debug) {
      const configSourceApiVersion = this.force.getConfig().getAppConfig().sourceApiVersion;
      const sourceApiVersion = !_.isNil(configSourceApiVersion)
        ? configSourceApiVersion
        : this.force.getConfig().getApiVersion();

      pkg.setVersion(sourceApiVersion);

      return BBPromise.resolve(
        new ManifestCreateApi(this.force).createManifestForMdapiPackage(options, pkg, this.smmHelper.metadataRegistry)
      );
    } else {
      return BBPromise.resolve({ file: options.packageXml });
    }
  }

  static _didRetrieveSucceed(result) {
    return (
      !_.isNil(result) &&
      result.success &&
      result.status === 'Succeeded' &&
      _.isNil(result.messages) &&
      !_.isNil(result.fileProperties) &&
      Array.isArray(result.fileProperties)
    );
  }

  async _postRetrieve(result, options) {
    let changedSourceElements: AggregateSourceElements;
    let inboundFiles: WorkspaceElementObj[];

    if (MdapiPullApi._didRetrieveSucceed(result)) {
      changedSourceElements = await this._syncDownSource(result, options, this.swa);
      // NOTE: Even if no updates were made, we need to update source tracking for those elements
      // E.g., we pulled metadata but it's the same locally so it's not seen as a change.
      inboundFiles = changedSourceElements
        .getAllWorkspaceElements()
        .map(workspaceElement => workspaceElement.toObject());

      // WARNING
      // there exists a race condition here where between when we query / pull / write
      // to maxRevision.json - something could've changed on the server this change will appear on the next command
      // the metadata api should be updated to return RevisionCounter with each of the source members returned

      await SourceLocations.nonDecomposedElementsIndex.maybeRefreshIndex(inboundFiles);
      await SourceUtil.getSourceMembersFromResult(inboundFiles, this.maxRevision);
      await this.maxRevision.updateSourceTracking();
    }

    return this._processResults(result, inboundFiles);
  }

  async _syncDownSource(result, options, swa: SourceWorkspaceAdapter): Promise<AggregateSourceElements> {
    const changedSourceElements = new AggregateSourceElements();

    // Each Aura bundle has a definition file that has one of the suffixes: .app, .cmp, .design, .evt, etc.
    // In order to associate each sub-component of an aura bundle (e.g. controller, style, etc.) with
    // its parent aura definition type, we must find its parent's file properties and pass those along
    // to processMdapiFileProperty.  Similarly, for other BundleMetadataTypes.
    const bundleFileProperties = BundleMetadataType.getDefinitionProperties(
      result.fileProperties,
      this.swa.metadataRegistry
    );

    result.fileProperties.forEach(fileProperty => {
      if (fileProperty.type === 'Package') {
        return;
      }
      // After retrieving, switch back to path separators (for Windows)
      fileProperty.fullName = pathUtil.replaceForwardSlashes(fileProperty.fullName);
      fileProperty.fileName = pathUtil.replaceForwardSlashes(fileProperty.fileName);
      this.swa.processMdapiFileProperty(
        changedSourceElements,
        options.retrievetargetdir,
        fileProperty,
        bundleFileProperties
      );
    });

    this.obsoleteNames.forEach(obsoleteName => {
      this.swa.handleObsoleteSource(changedSourceElements, obsoleteName.fullName, obsoleteName.type);
    });

    return swa.updateSource(
      changedSourceElements,
      options.manifest,
      false /** check for duplicates **/,
      options.unsupportedMimeTypes,
      options.forceoverwrite
    );
  }

  _processResults(result, inboundFiles: WorkspaceElementObj[]) {
    if (_.isNil(result)) {
      return;
    } else if (MdapiPullApi._didRetrieveSucceed(result)) {
      return { inboundFiles };
    } else {
      const retrieveFailed = new Error(syncCommandHelper.getRetrieveFailureMessage(result, this.messages));
      retrieveFailed.name = 'RetrieveFailed';
      throw retrieveFailed;
    }
  }

  async _checkForConflicts(options) {
    if (options.forceoverwrite) {
      // do not check for conflicts when pull --forceoverwrite
      return [];
    }
    const statusApi = await SrcStatusApi.create({ org: this.scratchOrg, adapter: this.swa });
    return statusApi
      .doStatus({ local: true, remote: true }) // rely on status so that we centralize the logic
      .then(() => statusApi.getLocalConflicts())
      .catch(err => {
        let errorMessage;
        if (err.errorCode === 'INVALID_TYPE') {
          const messages: Messages = Messages.loadMessages('salesforce-alm', 'source_pull');
          errorMessage = messages.getMessage('NonScratchOrgPull');
        } else {
          errorMessage = err.message;
        }
        const sfdxError = (SfdxError.wrap(err).message = errorMessage);
        throw sfdxError;
      })
      .then(conflicts => {
        if (conflicts.length > 0) {
          const error = new Error('Conflicts found during sync down');
          error['name'] = 'SourceConflict';
          error['sourceConflictElements'] = conflicts;
          throw error;
        }
      });
  }
}

export namespace MdapiPullApi {
  export interface Options {
    adapter?: SourceWorkspaceAdapter;
    org: any;
  }
}
