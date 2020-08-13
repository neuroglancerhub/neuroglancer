
import {defaultCredentialsManager} from 'neuroglancer/credentials_provider/default_manager';
import {credentialsKey} from 'neuroglancer/datasource/clio/api';
import {ClioCredentialsProvider} from 'neuroglancer/datasource/clio/credentials_provider';

defaultCredentialsManager.register(credentialsKey, (authServer) => new ClioCredentialsProvider(authServer));