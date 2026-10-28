// Exact post-patch integration; keep the upstream pinned PATCH untouched.
export function applyGroupIntakeRecoveryPatch(source, modulePrefix = '__DESKTOP_MODULES__/') {
  const once = (before, after) => {
    const index = source.indexOf(before);
    if (index < 0 || source.indexOf(before, index + before.length) >= 0) throw new Error('Group intake recovery integration anchor mismatch.');
    source = source.slice(0, index) + after + source.slice(index + before.length);
  };
  const imports = `import { prepareGroupRequestContext } from "${modulePrefix}group-request-policy.mjs";`;
  once(imports, `${imports}\nimport { createGroupIntakeRecovery } from "${modulePrefix}group-intake-recovery.mjs";`);
  const handlerStart = '  channel.on({\n    message: async (msg) => {\n      await withTrace(';
  const handlerEnd = '      ).catch((err) => log.fail("intake", err));\n    },\n    reject: (evt) => {';
  const start = source.indexOf(handlerStart);
  const end = source.indexOf(handlerEnd, start);
  if (start < 0 || end < start) throw new Error('Group intake live handler anchor mismatch.');
  let traceCall = 'withTrace(' + source.slice(start + handlerStart.length, end) + '      )';
  const groupDependency = '          groupDispatcher: () => groupDesktopDispatcher,';
  if (traceCall.split(groupDependency).length !== 2) throw new Error('Group intake dispatcher dependency mismatch.');
  traceCall = traceCall.replace(groupDependency, `${groupDependency}\n          groupIntakeRecovery,`);
  const wiring = `  const groupIntakeRecovery = createGroupIntakeRecovery({
    statePath: join(dirname(FIXED_GROUP_CONTROL_PATH), "group-intake-recovery.json"),
    groupId: FIXED_GROUP_ID, appId: cfg.accounts.app.id, channel, normalize,
    hasRequest: (messageId) => Boolean(groupDesktopDispatcher?.messageIndex?.has(messageId)),
    onMessage: (msg) => handleIncomingMessage(msg),
    logger: (event) => log.info("group-intake-recovery", event.event, event),
  });
  const handleIncomingMessage = (msg) => ${traceCall};
`;
  source = source.slice(0, start) + wiring + '  channel.on({\n    message: async (msg) => {\n      await handleIncomingMessage(msg).catch((err) => log.fail("intake", err));\n    },\n    reject: (evt) => {' + source.slice(end + handlerEnd.length);
  once('  await supplementalGroups.initialize();', '  await supplementalGroups.initialize();\n  if (groupDesktopDispatcher && (await groupControlReady)?.botAppId === cfg.accounts.app.id) groupIntakeRecovery.start();');
  once('      activeRuns.pauseNewRuns("bridge-disconnect");', '      activeRuns.pauseNewRuns("bridge-disconnect");\n      groupIntakeRecovery.close();');
  once('      if (!groupDispatcher) return;\n      await deps.groupRecorder.sync();', '      if (!groupDispatcher) return;\n      deps.groupIntakeRecovery?.record(msg.messageId);\n      await deps.groupRecorder.sync();');
  const done = '      log.info("group-desktop", "dispatched", { groupId: FIXED_GROUP_ID, messageId: msg.messageId });';
  once(done, `      if (groupDispatcher.messageIndex.has(msg.messageId)) deps.groupIntakeRecovery?.markHandled(msg.messageId);\n${done}`);
  return source;
}
