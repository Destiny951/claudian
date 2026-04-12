import { createInterface } from 'node:readline';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import { execFile } from 'node:child_process';

const DEFAULT_AGENT_DIR = path.join(os.homedir(), '.pi', 'agent');
const PI_GLOBAL_PACKAGE_SEGMENTS = ['@mariozechner', 'pi-coding-agent', 'dist', 'index.js'];

let sdkPromise = null;
let compactionModulePromise = null;
let sessionManagerModulePromise = null;
let session = null;
let sessionCwd = null;
let globalNpmRootPromise = null;

function getNpmExecutable() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

async function getGlobalNpmRoot() {
  if (!globalNpmRootPromise) {
    globalNpmRootPromise = new Promise((resolve, reject) => {
      execFile(getNpmExecutable(), ['root', '-g'], (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }

        const root = stdout.trim();
        if (!root) {
          reject(new Error('Failed to resolve global npm root for PI SDK.'));
          return;
        }

        resolve(root);
      });
    });
  }

  return globalNpmRootPromise;
}

async function resolvePiSdkUrl() {
  const globalNpmRoot = await getGlobalNpmRoot();
  const sdkPath = path.join(globalNpmRoot, ...PI_GLOBAL_PACKAGE_SEGMENTS);
  return pathToFileURL(sdkPath).href;
}

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function toErrorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

async function loadSdk() {
  if (sdkPromise) {
    return sdkPromise;
  }

  sdkPromise = (async () => {
    const sdkUrl = await resolvePiSdkUrl();
    return import(sdkUrl);
  })();

  return sdkPromise;
}

async function loadCompactionModule() {
  if (compactionModulePromise) {
    return compactionModulePromise;
  }

  compactionModulePromise = (async () => {
    const sdkUrl = await resolvePiSdkUrl();
    const basePath = new URL(sdkUrl).pathname;
    const compactionModulePath = path.join(path.dirname(basePath), 'core', 'compaction', 'compaction.js');
    return import(pathToFileURL(compactionModulePath).href);
  })();

  return compactionModulePromise;
}

async function loadSessionManagerModule() {
  if (sessionManagerModulePromise) {
    return sessionManagerModulePromise;
  }

  sessionManagerModulePromise = (async () => {
    const sdkUrl = await resolvePiSdkUrl();
    const basePath = new URL(sdkUrl).pathname;
    const sessionManagerModulePath = path.join(path.dirname(basePath), 'core', 'session-manager.js');
    return import(pathToFileURL(sessionManagerModulePath).href);
  })();

  return sessionManagerModulePromise;
}

async function estimateTokensFromMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return null;
  }

  try {
    const helpers = await loadCompactionModule();
    const estimateTokens = helpers?.estimateTokens;
    if (typeof estimateTokens !== 'function') {
      return null;
    }

    let total = 0;
    for (const message of messages) {
      total += estimateTokens(message);
    }

    return Number.isFinite(total) ? total : null;
  } catch {
    return null;
  }
}

function findLatestCompactionEntry(entries) {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (entries[i]?.type === 'compaction') {
      return entries[i];
    }
  }
  return null;
}

async function estimateCalibratedTokensForSession(targetSession, rawEstimatedTokens) {
  if (typeof rawEstimatedTokens !== 'number' || !Number.isFinite(rawEstimatedTokens) || rawEstimatedTokens <= 0) {
    return rawEstimatedTokens;
  }

  const branchEntries = targetSession?.sessionManager?.getBranch?.() ?? [];
  const latestCompaction = findLatestCompactionEntry(branchEntries);
  if (!latestCompaction?.parentId || typeof latestCompaction.tokensBefore !== 'number' || latestCompaction.tokensBefore <= 0) {
    return rawEstimatedTokens;
  }

  try {
    const sessionManagerHelpers = await loadSessionManagerModule();
    const preCompactionBranch = targetSession.sessionManager.getBranch(latestCompaction.parentId);
    const preCompactionContext = sessionManagerHelpers.buildSessionContext(preCompactionBranch);
    const preCompactionRawEstimate = await estimateTokensFromMessages(preCompactionContext?.messages ?? []);
    if (
      typeof preCompactionRawEstimate !== 'number'
      || !Number.isFinite(preCompactionRawEstimate)
      || preCompactionRawEstimate <= 0
    ) {
      return rawEstimatedTokens;
    }

    const calibrationRatio = latestCompaction.tokensBefore / preCompactionRawEstimate;
    if (!Number.isFinite(calibrationRatio) || calibrationRatio <= 1) {
      return rawEstimatedTokens;
    }

    const calibrated = Math.round(rawEstimatedTokens * calibrationRatio);
    return Math.max(rawEstimatedTokens, calibrated);
  } catch {
    return rawEstimatedTokens;
  }
}

function calculatePercent(tokens, contextWindow) {
  if (typeof tokens !== 'number' || !Number.isFinite(tokens)) {
    return null;
  }
  if (typeof contextWindow !== 'number' || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return null;
  }
  return (tokens / contextWindow) * 100;
}

async function resolveContextUsageForSession(targetSession) {
  const sdkUsage = targetSession?.getContextUsage?.();
  if (sdkUsage && sdkUsage.tokens !== null && sdkUsage.percent !== null) {
    return sdkUsage;
  }

  const contextWindow = sdkUsage?.contextWindow
    ?? targetSession?.model?.contextWindow
    ?? targetSession?.agent?.state?.model?.contextWindow
    ?? 0;
  const rawEstimatedTokens = await estimateTokensFromMessages(targetSession?.messages ?? []);
  const estimatedTokens = await estimateCalibratedTokensForSession(targetSession, rawEstimatedTokens);

  return {
    tokens: estimatedTokens,
    contextWindow,
    percent: calculatePercent(estimatedTokens, contextWindow),
  };
}

async function preparePiCompaction(targetSession) {
  const helpers = await loadCompactionModule();
  const pathEntries = targetSession?.sessionManager?.getBranch?.() ?? [];
  const settings = targetSession?.settingsManager?.getCompactionSettings?.()
    ?? helpers.DEFAULT_COMPACTION_SETTINGS;
  const firstBranchEntryId = pathEntries[0]?.id ?? null;

  const isMeaningfulPreparation = (preparation) => {
    if (!preparation) {
      return false;
    }
    if ((preparation.messagesToSummarize?.length ?? 0) > 0) {
      return true;
    }
    if ((preparation.turnPrefixMessages?.length ?? 0) > 0) {
      return true;
    }
    return preparation.firstKeptEntryId !== firstBranchEntryId;
  };

  const buildPreparation = (keepRecentTokens) => helpers.prepareCompaction(pathEntries, {
    ...settings,
    keepRecentTokens,
  });

  const initialPreparation = buildPreparation(settings.keepRecentTokens);
  if (!initialPreparation) {
    return null;
  }
  if (isMeaningfulPreparation(initialPreparation)) {
    return initialPreparation;
  }

  const rawMessageTokens = await estimateTokensFromMessages(targetSession?.messages ?? []);
  const tokensBefore = typeof initialPreparation.tokensBefore === 'number'
    ? initialPreparation.tokensBefore
    : null;

  if (
    rawMessageTokens === null
    || rawMessageTokens <= 0
    || tokensBefore === null
    || tokensBefore <= 0
  ) {
    return initialPreparation;
  }

  let keepRecentTokens = Math.floor(settings.keepRecentTokens * (rawMessageTokens / tokensBefore));
  keepRecentTokens = Math.max(1024, Math.min(settings.keepRecentTokens - 1, keepRecentTokens));

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const candidate = buildPreparation(keepRecentTokens);
    if (!candidate) {
      return initialPreparation;
    }
    if (isMeaningfulPreparation(candidate)) {
      return candidate;
    }
    if (keepRecentTokens <= 1024) {
      return candidate;
    }
    keepRecentTokens = Math.max(1024, Math.floor(keepRecentTokens * 0.65));
  }

  return initialPreparation;
}

async function compactPiSession(targetSession, customInstructions) {
  const pathEntries = targetSession?.sessionManager?.getBranch?.() ?? [];
  if (pathEntries.some((entry) => entry?.type === 'compaction')) {
    throw new Error('Already compacted');
  }

  const preparation = await preparePiCompaction(targetSession);
  if (!preparation) {
    const lastEntry = pathEntries[pathEntries.length - 1];
    if (lastEntry?.type === 'compaction') {
      throw new Error('Already compacted');
    }
    throw new Error('Nothing to compact (session too small)');
  }
  if (
    (preparation.messagesToSummarize?.length ?? 0) === 0
    && (preparation.turnPrefixMessages?.length ?? 0) === 0
  ) {
    throw new Error('Nothing to compact meaningfully');
  }

  const helpers = await loadCompactionModule();
  const model = targetSession?.model;
  if (!model) {
    throw new Error('No model selected');
  }

  const auth = await targetSession._getRequiredRequestAuth(model);
  const result = await helpers.compact(
    preparation,
    model,
    auth.apiKey,
    auth.headers,
    customInstructions,
    undefined,
  );

  targetSession.sessionManager.appendCompaction(
    result.summary,
    result.firstKeptEntryId,
    result.tokensBefore,
    result.details,
    false,
  );

  const sessionContext = targetSession.sessionManager.buildSessionContext();
  if (targetSession.agent?.state) {
    targetSession.agent.state.messages = sessionContext.messages;
  }

  return result;
}

async function ensureSession(cwd, requestedSessionId = null) {

  if (
    session
    && sessionCwd === cwd
    && (requestedSessionId == null || session.sessionId === requestedSessionId)
  ) {
    return session;
  }

  const {
    SessionManager,
    DefaultResourceLoader,
    SettingsManager,
    bashTool,
    createAgentSession,
    editTool,
    findTool,
    getDefaultSessionDir,
    grepTool,
    lsTool,
    readTool,
    writeTool,
  } = await loadSdk();

  if (session) {
    try {
      await session.abort();
    } catch {
      // no-op
    }
  }

  const agentDir = DEFAULT_AGENT_DIR;
  let resourceLoader;

  if (DefaultResourceLoader && SettingsManager?.inMemory) {
    try {
      const settingsManager = SettingsManager.inMemory();
      resourceLoader = new DefaultResourceLoader({
        cwd,
        agentDir,
        settingsManager,
      });
      await resourceLoader.reload();
    } catch {
      resourceLoader = undefined;
    }
  }

  let sessionManager;
  if (requestedSessionId) {
    try {
      const sessionDir = typeof getDefaultSessionDir === 'function'
        ? getDefaultSessionDir(cwd, agentDir)
        : undefined;
      const sessions = await SessionManager.list(cwd, sessionDir);
      const matched = sessions.find((entry) => entry.id === requestedSessionId);
      if (matched?.path) {
        sessionManager = SessionManager.open(matched.path, sessionDir, cwd);
      }
    } catch {
      // ignore lookup failures and fall back to creating a new session
    }
  }

  const created = await createAgentSession({
    cwd,
    agentDir,
    ...(sessionManager ? { sessionManager } : {}),
    ...(resourceLoader ? { resourceLoader } : {}),
    tools: [readTool, bashTool, grepTool, findTool, lsTool, editTool, writeTool],
  });

  session = created.session;
  sessionCwd = cwd;
  return session;
}

async function handleInit(message) {
  if (!message.cwd || typeof message.cwd !== 'string') {
    write({ type: 'error', id: message.id, message: 'Missing cwd in init request' });
    return;
  }

  try {
    await ensureSession(message.cwd, message.sessionId);
    
    // Send init_ok first
    write({ type: 'init_ok', id: message.id, sessionId: session?.sessionId ?? null });
    
    // Then send initial context_usage if available (for restored sessions)
    const usage = await resolveContextUsageForSession(session);
    if (usage && usage.tokens !== null) {
      write({
        type: 'context_usage',
        id: message.id,
        usage: {
          tokens: usage.tokens,
          contextWindow: usage.contextWindow,
          percent: usage.percent,
        },
      });
    }
  } catch (error) {
    write({ type: 'error', id: message.id, message: toErrorMessage(error) });
  }
}

async function handlePrompt(message) {
  if (!session) {
    write({ type: 'error', id: message.id, message: 'Session not initialized. Send init first.' });
    return;
  }

  let unsubscribe = null;
  let sawAgentEnd = false;

  try {
    unsubscribe = session.subscribe((event) => {
      if (event?.type === 'agent_end') {
        sawAgentEnd = true;
      }
      write({ type: 'prompt_event', id: message.id, event });
    });

    await session.prompt(message.prompt);

    if (!sawAgentEnd) {
      write({ type: 'prompt_event', id: message.id, event: { type: 'agent_end' } });
    }

    const usage = await resolveContextUsageForSession(session);
    write({
      type: 'prompt_event',
      id: message.id,
      event: {
        type: 'context_usage',
        tokens: usage?.tokens ?? null,
        contextWindow: usage?.contextWindow ?? null,
        percent: usage?.percent ?? null,
      },
    });

    write({ type: 'prompt_done', id: message.id });
  } catch (error) {
    write({ type: 'error', id: message.id, message: toErrorMessage(error) });
  } finally {
    if (unsubscribe) {
      unsubscribe();
    }
  }
}

async function handleCancel(message) {
  try {
    if (session) {
      await session.abort();
    }
    write({ type: 'cancel_ok', id: message.id });
  } catch (error) {
    write({ type: 'error', id: message.id, message: toErrorMessage(error) });
  }
}

async function handleReset(message) {
  try {
    if (session) {
      await session.abort();
    }
    session = null;
    sessionCwd = null;
    write({ type: 'reset_ok', id: message.id });
  } catch (error) {
    write({ type: 'error', id: message.id, message: toErrorMessage(error) });
  }
}

async function handleListSkills(message) {
  if (!session) {
    write({ type: 'error', id: message.id, message: 'Session not initialized. Send init first.' });
    return;
  }

  try {
    const commands = await session.getCommands();
    const skills = commands.map((cmd) => ({
      name: cmd.name,
      description: cmd.description,
      source: cmd.source,
      sourceInfo: {
        path: cmd.sourceInfo?.path,
      },
    }));
    write({ type: 'list_skills_ok', id: message.id, skills });
  } catch (error) {
    write({ type: 'error', id: message.id, message: toErrorMessage(error) });
  }
}

async function handleDiscoverSkills(message) {
  if (!message.cwd || typeof message.cwd !== 'string') {
    write({ type: 'error', id: message.id, message: 'Missing cwd in discover_skills request' });
    return;
  }

  try {
    const sdk = await loadSdk();
    const { DefaultResourceLoader, SettingsManager } = sdk;

    const agentDir = DEFAULT_AGENT_DIR;
    let resourceLoader;

    if (DefaultResourceLoader && SettingsManager?.inMemory) {
      try {
        const settingsManager = SettingsManager.inMemory();
        resourceLoader = new DefaultResourceLoader({
          cwd: message.cwd,
          agentDir,
          settingsManager,
        });
        await resourceLoader.reload();
      } catch {
        resourceLoader = undefined;
      }
    }

    const commands = [];

    if (resourceLoader) {
      const skillsResult = resourceLoader.getSkills();
      for (const skill of skillsResult.skills) {
        commands.push({
          name: skill.name,
          description: skill.description,
          source: 'skill',
          sourceInfo: { path: skill.filePath },
        });
      }

      const promptsResult = resourceLoader.getPrompts();
      for (const prompt of promptsResult.prompts) {
        commands.push({
          name: prompt.name,
          description: prompt.description,
          source: 'prompt',
          sourceInfo: { path: prompt.filePath },
        });
      }

      const extensionsResult = resourceLoader.getExtensions();
      for (const ext of extensionsResult.commands || []) {
        commands.push({
          name: ext.name,
          description: ext.description,
          source: 'extension',
          sourceInfo: { path: ext.sourceInfo?.path },
        });
      }
    } else {
      const { loadSkills } = sdk;
      const result = await loadSkills({
        cwd: message.cwd,
        agentDir,
      });
      for (const skill of result.skills) {
        commands.push({
          name: skill.name,
          description: skill.description,
          source: 'skill',
          sourceInfo: { path: skill.filePath },
        });
      }
    }

    write({ type: 'list_skills_ok', id: message.id, skills: commands });
  } catch (error) {
    write({ type: 'error', id: message.id, message: toErrorMessage(error) });
  }
}

async function handleGetContextUsage(message) {
  if (!session) {
    write({ type: 'error', id: message.id, message: 'Session not initialized. Send init first.' });
    return;
  }

  try {
    const usage = await resolveContextUsageForSession(session);
    if (!usage) {
      write({ type: 'context_usage', id: message.id, usage: null });
      return;
    }
    write({
      type: 'context_usage',
      id: message.id,
      usage: {
        tokens: usage.tokens,
        contextWindow: usage.contextWindow,
        percent: usage.percent,
      },
    });
  } catch (error) {
    write({ type: 'error', id: message.id, message: toErrorMessage(error) });
  }
}

async function handleGetSessionStats(message) {
  if (!session) {
    write({ type: 'error', id: message.id, message: 'Session not initialized. Send init first.' });
    return;
  }

  try {
    const stats = session.getSessionStats();
    write({
      type: 'session_stats',
      id: message.id,
      stats: {
        tokens: stats.tokens,
        cost: stats.cost,
        contextUsage: stats.contextUsage
          ? {
              tokens: stats.contextUsage.tokens,
              contextWindow: stats.contextUsage.contextWindow,
              percent: stats.contextUsage.percent,
            }
          : undefined,
      },
    });
  } catch (error) {
    write({ type: 'error', id: message.id, message: toErrorMessage(error) });
  }
}

async function handleCompact(message) {
  if (!session) {
    write({ type: 'error', id: message.id, message: 'Session not initialized. Send init first.' });
    return;
  }
  const agentDir = DEFAULT_AGENT_DIR;
  const agentYamlPath = path.join(agentDir, 'agent.yaml');
  let hasAgentYaml = false;
  try {
    hasAgentYaml = fs.existsSync(agentYamlPath);
  } catch {
    // ignore
  }
  
  try {
    const result = await compactPiSession(session, message.customInstructions);
    const postCompactUsage = await resolveContextUsageForSession(session);
    const estimatedTokensAfter = typeof postCompactUsage?.tokens === 'number'
      ? postCompactUsage.tokens
      : await estimateTokensFromMessages(session?.messages ?? []);
    const sdkModel = session?.model;
    const modelId = sdkModel?.id || sdkModel?.modelId || 'unknown';
    
    write({
      type: 'compact_done',
      id: message.id,
      result: {
        tokensBefore: result?.tokensBefore ?? 0,
        estimatedTokensAfter,
        summary: result?.summary,
        usage: postCompactUsage,
        _diagnostics: {
          modelId,
          hasAgentYaml,
          summaryLength: result?.summary?.length ?? 0,
          messagesCount: session?.messages?.length ?? 0,
          firstKeptEntryId: result?.firstKeptEntryId ?? null,
        },
      },
    });
  } catch (error) {
    write({ type: 'error', id: message.id, message: toErrorMessage(error) });
  }
}

const rl = createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

rl.on('line', async (line) => {
  const trimmed = line.trim();
  if (!trimmed) {
    return;
  }

  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    write({ type: 'error', message: 'Invalid JSON request' });
    return;
  }

  if (!message?.type || !message?.id) {
    write({ type: 'error', message: 'Invalid request payload' });
    return;
  }

  switch (message.type) {
    case 'init':
      await handleInit(message);
      break;
    case 'prompt':
      await handlePrompt(message);
      break;
    case 'cancel':
      await handleCancel(message);
      break;
    case 'reset':
      await handleReset(message);
      break;
    case 'list_skills':
      await handleListSkills(message);
      break;
    case 'discover_skills':
      await handleDiscoverSkills(message);
      break;
    case 'get_context_usage':
      await handleGetContextUsage(message);
      break;
    case 'get_session_stats':
      await handleGetSessionStats(message);
      break;
    case 'compact':
      await handleCompact(message);
      break;
    default:
      write({ type: 'error', id: message.id, message: `Unknown request type: ${message.type}` });
      break;
  }
});

rl.on('close', async () => {
  if (session) {
    try {
      await session.abort();
    } catch {
      // no-op
    }
  }
  process.exit(0);
});
