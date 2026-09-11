import { mkdir, open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';

/** Secrets enter only the provider child, never Docker metadata or the launch specification. */
export async function applyAuthentication(credential, provider, env, home = '/home/worker', now = Date.now()) {
  if (credential.provider !== provider || !['claude', 'codex'].includes(provider)) throw new Error('PROVIDER_CREDENTIAL_MISMATCH');
  for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN']) delete env[key];
  if (credential.expiresAt !== undefined && credential.expiresAt <= now + 60_000) throw new Error('CONTAINER_SUBSCRIPTION_LOGIN_EXPIRED');
  if (credential.kind === 'api-key' || credential.kind === undefined) {
    if (typeof credential.apiKey !== 'string' || !credential.apiKey) throw new Error('PROVIDER_CREDENTIAL_INVALID');
    env[provider === 'claude' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'] = credential.apiKey;
  } else if (provider === 'claude' && credential.kind === 'claude-subscription') {
    if (typeof credential.oauthToken !== 'string' || !credential.oauthToken) throw new Error('PROVIDER_CREDENTIAL_INVALID');
    // The isolated home has no first-run preferences. The operator selected subscription
    // auth already; skip account/theme onboarding without granting workspace/tool trust.
    const preferences = await open(join(home, '.claude.json'), constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    try {
      const source = await preferences.readFile('utf8');
      const config = source ? JSON.parse(source) : {};
      if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('PROVIDER_AUTH_PATH_REFUSED');
      if (config.hasCompletedOnboarding !== true) {
        const body = JSON.stringify({ ...config, hasCompletedOnboarding: true });
        await preferences.truncate(0); await preferences.write(body, 0, 'utf8'); await preferences.sync();
      }
    } finally { await preferences.close(); }
    env.CLAUDE_CODE_OAUTH_TOKEN = credential.oauthToken;
  } else if (provider === 'codex' && credential.kind === 'codex-subscription') {
    if (credential.auth?.auth_mode !== 'chatgptAuthTokens' || credential.auth.OPENAI_API_KEY !== null
      || credential.auth.tokens?.refresh_token !== '') throw new Error('PROVIDER_CREDENTIAL_INVALID');
    const directory = join(home, '.codex');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (await realpath(directory) !== join(await realpath(home), '.codex')) throw new Error('PROVIDER_AUTH_PATH_REFUSED');
    const file = await open(join(directory, 'auth.json'), constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
    try { await file.chmod(0o600); await file.writeFile(JSON.stringify(credential.auth)); await file.sync(); } finally { await file.close(); }
    env.CODEX_HOME = directory;
  } else throw new Error('PROVIDER_CREDENTIAL_MISMATCH');
}
