import { ModelMessage } from 'ai';

function hasToolCalls(msg: ModelMessage): boolean {
  if (Array.isArray(msg.content)) {
    return msg.content.some(part => part.type === 'tool-call');
  }
  return false;
}

function isValidSplitPoint(messages: ModelMessage[], index: number): boolean {
  if (index <= 0 || index >= messages.length) return true;
  
  const currentMsg = messages[index - 1];
  const nextMsg = messages[index];
  
  // Do not split between assistant tool-calls and tool results
  if (nextMsg.role === 'tool') return false;
  if (currentMsg.role === 'assistant' && hasToolCalls(currentMsg)) return false;
  
  return true;
}

function estimateTokenCount(messages: ModelMessage[]): number {
  const charCount = JSON.stringify(messages).length;
  return Math.ceil(charCount / 4.0); // Simple 4 chars/token heuristic
}

export async function compactMessages(
  messages: ModelMessage[],
  maxTokens: number,
  summarizeFn: (textToSummarize: string) => Promise<string>
): Promise<ModelMessage[]> {
  const currentTokens = estimateTokenCount(messages);
  
  // Only trigger if we exceed 75% of the threshold limit
  if (currentTokens <= maxTokens * 0.75 || messages.length < 4) {
    return messages;
  }
  
  console.log(`\n🔄 [Compaction Triggered] Current tokens: ${currentTokens}, threshold: ${maxTokens}`);
  
  // Find a split point near the 50% mark
  const targetPruneIndex = Math.floor(messages.length / 2);
  let splitIndex = -1;
  
  // Search for the closest valid split point to targetPruneIndex
  for (let offset = 0; offset < messages.length; offset++) {
    const idx1 = targetPruneIndex + offset;
    const idx2 = targetPruneIndex - offset;
    
    if (idx1 < messages.length && isValidSplitPoint(messages, idx1)) {
      splitIndex = idx1;
      break;
    }
    if (idx2 > 0 && isValidSplitPoint(messages, idx2)) {
      splitIndex = idx2;
      break;
    }
  }
  
  if (splitIndex <= 0) {
    console.log('⚠️ Could not find a valid split point for compaction. Skipping.');
    return messages;
  }
  
  const toPrune = messages.slice(0, splitIndex);
  const toKeep = messages.slice(splitIndex);
  
  // Generate textual representation of the conversation to prune
  const pruneText = toPrune
    .map(msg => {
      let contentStr = '';
      if (typeof msg.content === 'string') {
        contentStr = msg.content;
      } else if (Array.isArray(msg.content)) {
        contentStr = msg.content
          .map(part => {
            if (part.type === 'text') return part.text;
            if (part.type === 'tool-call') return `[Tool Call: ${part.toolName}]`;
            if (part.type === 'tool-result') return `[Tool Result]`;
            return '';
          })
          .join(' ');
      }
      return `${msg.role.toUpperCase()}: ${contentStr}`;
    })
    .join('\n');
    
  try {
    console.log('🧠 Summarizing older chat context...');
    const summary = await summarizeFn(pruneText);
    
    const summaryMessage: ModelMessage = {
      role: 'user',
      content: `System Note: The following is a summary of the older conversation log for context preservation:\n=== CONTEXT SUMMARY ===\n${summary}\n=======================`
    };
    
    const compacted = [summaryMessage, ...toKeep];
    console.log(`✅ Compaction complete. Old length: ${messages.length}, New length: ${compacted.length}`);
    return compacted;
  } catch (err: any) {
    console.error(`❌ Compaction summary failed: ${err.message}. Preserving history.`);
    return messages;
  }
}
