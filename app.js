import { mountQuestionnaire, unavailableScreen } from './engine.js';

try {
  const response = await fetch('./manifest.json', {cache: 'no-store', credentials: 'omit'});
  if (!response.ok) throw new Error('Manifest unavailable');
  mountQuestionnaire(await response.json());
} catch { unavailableScreen(); }
