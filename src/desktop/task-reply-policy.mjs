// Route once from the current message only; references, history, attachments and
// eventual run duration must not promote an ordinary reply into a new topic.
function currentMessageRequestsTaskThread(content) {
  if (typeof content !== "string") return false;
  const text = content
    .replace(/```[\s\S]*?```|`[^`\n]*`/g, " ")
    .replace(/^\s*>.*$/gm, " ")
    .replace(/“[^”]*”|「[^」]*」|『[^』]*』|"[^"\n]*"/g, " ")
    .replace(/<at\b[^>]*>[\s\S]*?<\/at>|@_user_\d+/g, " ");
  const instructions = text.split(/[，,。！？!?；;\n]+/).map((part) => {
    let instruction = part.trim();
    // Preserve polite work requests such as 可以帮我生成PPT吗.
    const prefix = /^(?:请你?|麻烦你?|劳驾|(?:能不能|能否|可以|可不可以)帮我|你帮我|帮我|帮忙|给我|替我|为我|我想要?|我需要|我要|我希望|先|然后|再|最后)\s*/;
    for (let i = 0; i < 3; i++) instruction = instruction.replace(prefix, "");
    return instruction;
  });
  // An opt-out wins if the current request contains conflicting instructions.
  if (/别开(?:个|一个)?话题|不(?:要|用|想|必)(?:开(?:个|一个)?)?话题|群里直接回|直接在群里回/.test(text)) return false;
  if (instructions.some((part) => /^(?:这(?:个|次)(?:任务|请求)?(?:请)?)?(?:开(?:个|一个)?话题|在话题里回复|放到话题)/.test(part) &&
    !/怎么|如何|是什么|什么意思|有什么|要多久|需要多久/.test(part))) return true;
  // A strong action must begin an instruction clause. Questions about how to do
  // work, bare words such as 生成/修改/分析, and pasted prose are not enough.
  return instructions.some((instruction) => {
    if (/是什么意思|有什么用|需要什么|需要多久|要多久|会做吗|能做吗/.test(instruction)) return false;
    if (/^(?:制作|做|写|撰写|编写|重写|改写|整理成|生成|输出|修改|编辑|完善|优化)[^，,。！？!?；;\n]{0,24}(?:报告|文档|PPT|PowerPoint|演示文稿|方案|推文|文章|稿件)/i.test(instruction)) return true;
    if (/^(?:校对|审阅|检查|润色|重写|改写|排版)[^，,。！？!?；;\n]{0,24}(?:推文|文章|稿件|文案|文档|报告)/.test(instruction)) return true;
    if (/^(?:生成|制作|做|画|绘制|设计|编辑|修改|调整|美化|重绘|制图)[^，,。！？!?；;\n]{0,24}(?:海报|图片|图像|这张图|照片|插画|插图|配图|头图|封面|流程图|架构图|示意图|图标|logo)/i.test(instruction)) return true;
    if (/^(?:把|将)[^，,。！？!?；;\n]{0,20}(?:这张图|图片|图像|海报|背景)[^，,。！？!?；;\n]{0,12}(?:改成|换成|编辑|修改|调整|美化|去掉|删除|移除|替换)/.test(instruction)) return true;
    if (/^(?:写|编写|重写|修改|修复|调试|开发|部署|实现|重构)[^，,。！？!?；;\n]{0,24}(?:代码|程序|脚本|服务|应用|系统|接口|网站|工具|机器人|插件|组件|功能|bug)/i.test(instruction)) return true;
    if (/^批量(?:处理|修改|编辑|转换|生成|导出|导入|重命名|整理|压缩|提取|删除)/.test(instruction)) return true;
    // Explicit multi-step production, e.g. 分析数据并输出报告, needs both
    // a workflow connector and a named deliverable in this current clause.
    return /^(?:查找|搜集|收集|检索|整理|分析|提取|汇总|处理)[^，,。！？!?；;\n]{0,32}(?:并|然后|再)[^，,。！？!?；;\n]{0,12}(?:生成|输出|制作|写成|整理成|导出)[^，,。！？!?；;\n]{0,20}(?:报告|文档|PPT|方案|文章|海报|图片|表格|清单|文件)/i.test(instruction);
  });
}

export function taskScopeReplyOptions(msg, control) {
  // Existing topics stay together, including requests that say not to open one.
  const replyInThread = Boolean(msg.threadId || msg.feishuReplyThreadId || msg.feishuReplyTopicId || msg.feishuReplyChatMode === "topic") ||
    (control?.taskReplyMode === "long_tasks_in_thread" && currentMessageRequestsTaskThread(msg.content));
  return {
    replyTo: msg.messageId,
    ...(replyInThread ? { replyInThread: true } : {}),
  };
}

// Call only after the caller has verified its existing private-chat binding.
// Preserve the original normalized message and all quote/source identifiers.
export function canonicalPrivateExecutionMessage(msg) {
  if (!msg.threadId && !msg.topicId && msg.chatMode !== "topic") return msg;
  const { threadId, topicId, chatMode, ...executionMessage } = msg;
  return { ...executionMessage,
    ...(threadId ? { feishuReplyThreadId: threadId } : {}),
    ...(topicId ? { feishuReplyTopicId: topicId } : {}),
    ...(chatMode ? { feishuReplyChatMode: chatMode } : {}),
  };
}
