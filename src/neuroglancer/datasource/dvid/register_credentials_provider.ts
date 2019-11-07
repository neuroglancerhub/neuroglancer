import {defaultCredentialsManager} from 'neuroglancer/credentials_provider/default_manager';
import {credentialsKey} from 'neuroglancer/datasource/dvid/api';
import {DVIDCredentialsProvider} from 'neuroglancer/datasource/dvid/credentials_provider';

export function registerDVIDCredentialsProvider(key: string) {
  defaultCredentialsManager.register(
    key, (authServer) => new DVIDCredentialsProvider(authServer));
}

export function isDVIDCredentialsProviderRegistered(key: string) {
  return defaultCredentialsManager.base.providers.has(key);
}

registerDVIDCredentialsProvider(credentialsKey);