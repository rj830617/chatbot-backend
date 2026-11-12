import { applicationDefault, getApps, initializeApp, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { env } from './env';

function initApp(): App {
  const existing = getApps()[0];
  if (existing) return existing;

  // With FIRESTORE_EMULATOR_HOST set, firebase-admin talks to the emulator
  // and no credentials are needed. Otherwise use Application Default
  // Credentials (GOOGLE_APPLICATION_CREDENTIALS or the hosting environment).
  if (env.FIRESTORE_EMULATOR_HOST) {
    return initializeApp({ projectId: env.FIREBASE_PROJECT_ID });
  }
  return initializeApp({ projectId: env.FIREBASE_PROJECT_ID, credential: applicationDefault() });
}

export const firebaseApp = initApp();
export const firestore: Firestore = getFirestore(firebaseApp);
