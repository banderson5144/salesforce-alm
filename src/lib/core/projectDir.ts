/*
 * Copyright (c) 2018, salesforce.com, inc.
 * All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 * For full license text, see the LICENSE file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

/* --------------------------------------------------------------------------------------------------------------------
 * WARNING: This file has been deprecated and should now be considered locked against further changes.  Its contents
 * have been partially or wholely superceded by functionality included in the @salesforce/core npm package, and exists
 * now to service prior uses in this repository only until they can be ported to use the new @salesforce/core library.
 *
 * If you need or want help deciding where to add new functionality or how to migrate to the new library, please
 * contact the CLI team at alm-cli@salesforce.com.
 * ----------------------------------------------------------------------------------------------------------------- */

// Node
import * as path from 'path';
import * as fs from 'fs';

// Local
import * as _ from 'lodash';
import messages = require('../messages');

/**
 * Function to compute the proper project directory. You would find .git in this location.
 */
const local = {
  getPath() {
    let foundProjectDir = null;

    // Require is here because there is a circular dependency
    const Config = require('./configApi').Config; // eslint-disable-line global-require

    const config = new Config();

    const _messages = messages(config.getLocale());

    const traverseForFile = function(workingDir, file) {
      try {
        fs.statSync(path.join(workingDir, file));
        foundProjectDir = workingDir;
      } catch (err) {
        if (err && err.code === 'ENOENT') {
          const indexOflastSlash = workingDir.lastIndexOf(path.sep);
          if (indexOflastSlash > 0) {
            traverseForFile(workingDir.substring(0, indexOflastSlash), file);
          } else {
            const error = new Error(_messages.getMessage('InvalidProjectWorkspace'));
            error['name'] = 'InvalidProjectWorkspace';
            throw error;
          }
        }
      }
    };

    try {
      traverseForFile(process.cwd(), config.getWorkspaceConfigFilename());
    } catch (error) {
      try {
        traverseForFile(process.cwd(), config.getOldAndBustedWorkspaceConfigFilename()); // check to see if we have an old workspace file to show a different message
        error['message'] = _messages.getMessage('OldSfdxWorkspaceJsonPresent', foundProjectDir);
        error['oldAndBustedPath'] = foundProjectDir; // if we do then override original error message
      } catch (ignore) {
        // ignore this error, it's fine that the old workspace file is not present
      }
      throw error;
    }

    return foundProjectDir;
  }
};

export = local;
