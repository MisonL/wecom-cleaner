const LEGACY_HINTS = new Map([
  ['--cleanup-monthly', '请改用: wecom-cleaner plan monthly-cleanup ...'],
  ['--analysis-only', '请改用: wecom-cleaner inspect footprint ...'],
  ['--space-governance', '请改用: wecom-cleaner plan space-governance ...'],
  ['--restore-batch', '请改用: wecom-cleaner recover restore <batch-id> ...'],
  ['--recycle-maintain', '请改用: wecom-cleaner recover recycle ...'],
  ['--doctor', '请改用: wecom-cleaner inspect doctor'],
  ['--check-update', '请改用: wecom-cleaner update check'],
  ['--upgrade', '请改用: wecom-cleaner update apply <npm|github-script> ...'],
  ['--sync-skills', '请改用: wecom-cleaner skills sync ...'],
  ['--service-install', '请改用: wecom-cleaner service install ...'],
  ['--service-uninstall', '请改用: wecom-cleaner service uninstall'],
  ['--service-status', '请改用: wecom-cleaner service status'],
  ['--service-run', '请改用: wecom-cleaner service run ...'],
]);
const GLOBAL_VALUE_FLAGS = new Set([
  '--root',
  '--state-root',
  '--output',
  '--theme',
  '--external-storage-root',
  '--external-storage-auto-detect',
]);
const GLOBAL_BOOL_FLAGS = new Set(['--json', '--force', '--interactive']);

function hasToken(argv, token) {
  return Array.isArray(argv) && argv.includes(token);
}

function hasOutputFlag(argv) {
  return hasToken(argv, '--output') || hasToken(argv, '--json');
}

function withDefaultOutput(argv, fallback = 'agent-json') {
  return hasOutputFlag(argv) ? argv : [...argv, '--output', fallback];
}

function consumeFlagValue(args, flag, fallback = '') {
  const idx = args.indexOf(flag);
  if (idx < 0) {
    return fallback;
  }
  return idx + 1 < args.length ? String(args[idx + 1] || '') : fallback;
}

function stripFlag(args, flag) {
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === flag) {
      i += 1;
      continue;
    }
    out.push(args[i]);
  }
  return out;
}

function withAckDrivenExecution(args, ack, defaultAck = 'APPLY') {
  const stripped = stripFlag(args, '--ack');
  return ack === defaultAck
    ? [...stripped, '--dry-run', 'false', '--yes']
    : [...stripped, '--dry-run', 'true'];
}

export function detectLegacyActionFlag(argv = []) {
  return argv.find((token) => LEGACY_HINTS.has(token)) || '';
}

export function legacyMigrationHint(flag) {
  return LEGACY_HINTS.get(flag) || '请执行 wecom-cleaner help 查看 v2 用法。';
}

export function renderV2Usage(appMeta = {}) {
  const versionText = appMeta?.version ? ` v${appMeta.version}` : '';
  return [
    `wecom-cleaner${versionText}`,
    '',
    '用法：',
    '  wecom-cleaner inspect footprint [选项]',
    '  wecom-cleaner inspect doctor [选项]',
    '  wecom-cleaner plan monthly-cleanup [选项]',
    '  wecom-cleaner plan space-governance [选项]',
    '  wecom-cleaner apply <plan-id> --ack APPLY [选项]',
    '  wecom-cleaner verify <run-id> [选项]',
    '  wecom-cleaner recover restore <batch-id> [选项]',
    '  wecom-cleaner recover recycle [选项]',
    '  wecom-cleaner service install|status|run|uninstall [选项]',
    '  wecom-cleaner update check [选项]',
    '  wecom-cleaner update apply <npm|github-script> [选项]',
    '  wecom-cleaner skills status [选项]',
    '  wecom-cleaner skills sync [选项]',
    '',
    '通用选项：',
    '  --output text|agent-json',
    '  --root <path>',
    '  --state-root <path>',
    '  --accounts all|current|id1,id2',
    '  --categories key1,key2',
    '  --months YYYY-MM,YYYY-MM',
    '  --cutoff-month YYYY-MM',
    '',
    '说明：',
    '  - v2 已移除旧顶层动作旗标，不再接受 --cleanup-monthly 等旧入口。',
    '  - 自动化调用统一使用 --output agent-json。',
    '  - 破坏性执行统一通过 apply / recover / service run / skills sync / update apply 入口触发。',
  ].join('\n');
}

export function extractGlobalLegacyArgv(argv = []) {
  const out = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (GLOBAL_BOOL_FLAGS.has(token)) {
      out.push(token);
      continue;
    }
    if (GLOBAL_VALUE_FLAGS.has(token) && i + 1 < argv.length) {
      out.push(token, argv[i + 1]);
      i += 1;
    }
  }
  return out;
}

export function parseControllerCommandArgv(argv = []) {
  if (!Array.isArray(argv) || argv.length === 0) {
    return { kind: 'interactive' };
  }
  const [domain, subcommand, third, ...rest] = argv;
  if (domain.startsWith('-')) {
    return { kind: 'legacy' };
  }

  if (domain === 'help') {
    return { kind: 'help' };
  }
  if (domain === 'inspect' && subcommand === 'footprint') {
    return {
      kind: 'inspect_footprint',
      action: 'analysis_only',
      legacyArgv: withDefaultOutput(['--analysis-only', ...argv.slice(2)]),
      controllerKind: 'inspect_footprint',
    };
  }
  if (domain === 'inspect' && subcommand === 'doctor') {
    return {
      kind: 'mapped',
      action: 'doctor',
      legacyArgv: withDefaultOutput(['--doctor', ...argv.slice(2)]),
      controllerKind: 'inspect_doctor',
    };
  }
  if (domain === 'plan' && subcommand === 'monthly-cleanup') {
    return {
      kind: 'plan',
      action: 'cleanup_monthly',
      legacyArgv: withDefaultOutput(['--cleanup-monthly', ...argv.slice(2), '--run-task', 'preview']),
      controllerKind: 'plan_monthly_cleanup',
    };
  }
  if (domain === 'plan' && subcommand === 'space-governance') {
    return {
      kind: 'plan',
      action: 'space_governance',
      legacyArgv: withDefaultOutput(['--space-governance', ...argv.slice(2), '--run-task', 'preview']),
      controllerKind: 'plan_space_governance',
    };
  }
  if (domain === 'apply' && subcommand) {
    return {
      kind: 'apply',
      planId: subcommand,
      ack: consumeFlagValue(argv, '--ack', ''),
      output: consumeFlagValue(argv, '--output', ''),
    };
  }
  if (domain === 'verify' && subcommand) {
    return {
      kind: 'verify',
      runId: subcommand,
      output: consumeFlagValue(argv, '--output', ''),
    };
  }
  if (domain === 'recover' && subcommand === 'restore' && third) {
    const tail = argv.slice(3);
    const ack = consumeFlagValue(argv, '--ack', '');
    return {
      kind: 'mapped',
      action: 'restore',
      legacyArgv: withDefaultOutput([
        '--restore-batch',
        third,
        ...withAckDrivenExecution(tail, ack, 'RESTORE'),
      ]),
      controllerKind: 'recover_restore',
    };
  }
  if (domain === 'recover' && subcommand === 'recycle') {
    const tail = argv.slice(2);
    const ack = consumeFlagValue(argv, '--ack', '');
    return {
      kind: 'mapped',
      action: 'recycle_maintain',
      legacyArgv: withDefaultOutput(['--recycle-maintain', ...withAckDrivenExecution(tail, ack, 'RECYCLE')]),
      controllerKind: 'recover_recycle',
    };
  }
  if (domain === 'service' && ['install', 'status', 'run', 'uninstall'].includes(subcommand)) {
    const actionMap = {
      install: '--service-install',
      status: '--service-status',
      run: '--service-run',
      uninstall: '--service-uninstall',
    };
    return {
      kind: 'mapped',
      action: `service_${subcommand}`,
      legacyArgv: withDefaultOutput(
        subcommand === 'run'
          ? [
              actionMap[subcommand],
              ...withAckDrivenExecution(argv.slice(2), consumeFlagValue(argv, '--ack', ''), 'SERVICE_RUN'),
            ]
          : [actionMap[subcommand], ...argv.slice(2)]
      ),
      controllerKind: `service_${subcommand}`,
    };
  }
  if (domain === 'update' && subcommand === 'check') {
    return {
      kind: 'mapped',
      action: 'check_update',
      legacyArgv: withDefaultOutput(['--check-update', ...argv.slice(2)]),
      controllerKind: 'update_check',
    };
  }
  if (domain === 'update' && subcommand === 'apply' && third) {
    return {
      kind: 'update_apply',
      method: third,
      ack: consumeFlagValue(argv, '--ack', ''),
      legacyArgv: withDefaultOutput(['--upgrade', third, ...stripFlag(argv.slice(3), '--ack')]),
      controllerKind: 'update_apply',
    };
  }
  if (domain === 'skills' && subcommand === 'sync') {
    const tail = argv.slice(2);
    const ack = consumeFlagValue(argv, '--ack', '');
    return {
      kind: 'mapped',
      action: 'sync_skills',
      legacyArgv: withDefaultOutput(['--sync-skills', ...withAckDrivenExecution(tail, ack, 'SKILLS_SYNC')]),
      controllerKind: 'skills_sync',
    };
  }
  if (domain === 'skills' && subcommand === 'status') {
    return {
      kind: 'skills_status',
      output: consumeFlagValue(argv, '--output', ''),
    };
  }
  return { kind: 'invalid', argv };
}
