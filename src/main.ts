import './styles.css';
import { initializeCore } from './core';
import { AppHost } from './app-host';
import { element } from './renderer';
import { initializeGitHubStars } from './github-stars';

void initializeGitHubStars();

try {
  await initializeCore();
  await new AppHost().start();
} catch (error) {
  const button = element<HTMLButtonElement>('#primaryButton');
  button.disabled = true;
  element('#primaryButtonLabel').textContent = 'RPEngine core failed to load';
  element('#primaryButtonDetail').textContent = error instanceof Error ? error.message : String(error);
  throw error;
}
