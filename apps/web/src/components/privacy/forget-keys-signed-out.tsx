'use client';

import { useEffect } from 'react';
import { forgetKeysOnSignOut } from '@/lib/privacy/browser';
import { useKeyStore } from './key-context';

/**
 * Rendered by every page that shows the visitor signed out (`SignInPrompt`, `/sign-in`): the
 * session is gone, so every privacy key in this browser is forgotten, in memory and on the
 * device, and other tabs are told (review M2, ADR-0018 §8 "Clearing"). Renders nothing.
 */
export function ForgetKeysWhenSignedOut() {
  const { store } = useKeyStore();
  useEffect(() => {
    void forgetKeysOnSignOut('session-ended', store);
  }, [store]);
  return null;
}
