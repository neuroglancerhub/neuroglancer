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

import {CredentialsProvider/*, makeCredentialsGetter*/} from 'neuroglancer/credentials_provider';
// import {StatusMessage} from 'neuroglancer/status';
import {/*CANCELED, CancellationTokenSource,*/ uncancelableToken} from 'neuroglancer/util/cancellation';
import {cancellableFetchOk} from 'neuroglancer/util/http_request';
import {ClioToken, responseText} from 'neuroglancer/datasource/clio/api';

interface AuthResponse {
  id_token: ClioToken
}

interface AuthResponseProvider {
  getAuthResponse: () => AuthResponse
}

interface AuthClient {
  auth: AuthResponseProvider
}

interface ClioNeurohub {
  clio: AuthClient
}

interface NeurohubWindow {
  neurohub: ClioNeurohub
}

const DEBUG_NEUROHUB_CREDENTIALS = false;

const mockWindow: NeurohubWindow = {
  neurohub: {
    clio: {
        auth: {
          getAuthResponse: () => {
            return {id_token: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiZW1haWwiOiJndWVzdEB0ZXN0LmNvbSJ9.TQVXqy_0z-cYXQnBXk_R1djE7VRbRZvOOwE5jl-vLXM"};
          }
        }
    }
  }
};

function getNeurohubToken(w: any) {
  if ('neurohub' in w) {
    return Promise.resolve((<NeurohubWindow><unknown>w).neurohub.clio.auth.getAuthResponse().id_token);
  } else {
    return Promise.resolve('');
  }
}

export class ClioCredentialsProvider extends CredentialsProvider<ClioToken> {
  constructor(public authServer: string) {
    super();
  }

  private getAuthToken(
    authServer: string,
    cancellationToken = uncancelableToken) {
    // console.log('getAuthToken:', authServer);
    if (!authServer) {
      // throw Error('token failure test');
      return Promise.resolve('');
    } else if (authServer.startsWith('token:')) {
      return Promise.resolve(authServer.substring(6));
    } else if (authServer == 'neurohub') {
      return getNeurohubToken(DEBUG_NEUROHUB_CREDENTIALS ? mockWindow : window);
    } else {
      const headers = new Headers();
      // headers.set('Access-Control-Allow-Origin', '*');
      return cancellableFetchOk(
        authServer,
        {'method': 'GET', credentials: 'include', headers},
        responseText,
        cancellationToken).catch(
          () => {
            return cancellableFetchOk(
              authServer,
              {'method': 'GET'},
              responseText,
              cancellationToken)/*.then(
                response => 'noinclude:' + response
              )*/;
          }
        );
    }
  }

  get = () => {
    return this.getAuthToken(this.authServer).then(token => {
      return {
        credentials: token,
        generation: 0
      };
    });
  }

  // get = makeCredentialsGetter(cancellationToken => {
  //   const status = new StatusMessage(/*delay=*/true);
  //   let cancellationSource: CancellationTokenSource|undefined;
  //   return new Promise<ClioToken>((resolve, reject) => {
  //     const dispose = () => {
  //       cancellationSource = undefined;
  //       status.dispose();
  //     };
  //     cancellationToken.add(() => {
  //       if (cancellationSource !== undefined) {
  //         cancellationSource.cancel();
  //         cancellationSource = undefined;
  //         status.dispose();
  //         reject(CANCELED);
  //       }
  //     });
  //     function writeLoginStatus(
  //         msg = 'Clio authorization required.', linkMessage = 'Request authorization.') {
  //       status.setText(msg + ' ');
  //       let button = document.createElement('button');
  //       button.textContent = linkMessage;
  //       status.element.appendChild(button);
  //       button.addEventListener('click', () => {
  //         window.alert('Please make sure you are an authorized user.');
  //       });
  //       status.setVisible(true);
  //     }
  //     let authServer = this.authServer;
  //     function login() {
  //       if (cancellationSource !== undefined) {
  //         cancellationSource.cancel();
  //       }
  //       cancellationSource = new CancellationTokenSource();
  //       writeLoginStatus('Waiting for Clio authorization...', 'Retry');
  //       getAuthToken(authServer, cancellationSource)
  //           .then(
  //               token => {
  //                 if (cancellationSource !== undefined) {
  //                   dispose();
  //                   resolve(token);
  //                 }
  //               },
  //               reason => {
  //                 if (cancellationSource !== undefined) {
  //                   cancellationSource = undefined;
  //                   writeLoginStatus(`Clio authorization failed: ${reason}.`, 'Retry');
  //                 }
  //               });
  //     }
  //     login();
  //   });
  // });
}
