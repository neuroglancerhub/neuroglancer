/**
 * @license
 * This work is a derivative of the Google Neuroglancer project,
 * Copyright 2016 Google Inc.
 * The Derivative Work is covered by
 * Copyright 2019 Howard Hughes Medical Institute
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {CredentialsProvider, makeCredentialsGetter} from 'neuroglancer/credentials_provider';
import {StatusMessage} from 'neuroglancer/status';
import {CANCELED, CancellationTokenSource, uncancelableToken} from 'neuroglancer/util/cancellation';
import {cancellableFetchOk} from 'neuroglancer/util/http_request';
import {DVIDToken, responseText} from 'neuroglancer/datasource/dvid/api';

function getAuthToken(
  authServer: string,
  cancellationToken = uncancelableToken) {
  // console.log('getAuthToken:', authServer);
  if (!authServer) {
    return Promise.resolve('');
  } else if (authServer.startsWith('token:')) {
    return Promise.resolve(authServer.substring(6));
  } else {
    const headers = new Headers();
    // headers.set('Access-Control-Allow-Origin', '*');
    return cancellableFetchOk(
      authServer, 
      {'method': 'GET', credentials: 'include', headers}, 
      responseText, 
      cancellationToken);
  }
}

export class DVIDCredentialsProvider extends CredentialsProvider<DVIDToken> {
  constructor(public authServer: string) {
    super();
  }

  get = makeCredentialsGetter(cancellationToken => {
    const status = new StatusMessage(/*delay=*/true);
    let cancellationSource: CancellationTokenSource|undefined;
    return new Promise<DVIDToken>((resolve, reject) => {
      const dispose = () => {
        cancellationSource = undefined;
        status.dispose();
      };
      cancellationToken.add(() => {
        if (cancellationSource !== undefined) {
          cancellationSource.cancel();
          cancellationSource = undefined;
          status.dispose();
          reject(CANCELED);
        }
      });
      function writeLoginStatus(
          msg = 'DVID authorization required.', linkMessage = 'Request authorization.') {
        status.setText(msg + ' ');
        let button = document.createElement('button');
        button.textContent = linkMessage;
        status.element.appendChild(button);
        button.addEventListener('click', () => {
          login();
        });
        status.setVisible(true);
      }
      let authServer = this.authServer;
      function login() {
        if (cancellationSource !== undefined) {
          cancellationSource.cancel();
        }
        cancellationSource = new CancellationTokenSource();
        writeLoginStatus('Waiting for DVID authorization...', 'Retry');
        getAuthToken(authServer, cancellationSource)
            .then(
                token => {
                  if (cancellationSource !== undefined) {
                    dispose();
                    resolve(token);
                  }
                },
                reason => {
                  if (cancellationSource !== undefined) {
                    cancellationSource = undefined;
                    writeLoginStatus(`DVID authorization failed: ${reason}.`, 'Retry');
                  }
                });
      }
      login();
    });
  });
}
