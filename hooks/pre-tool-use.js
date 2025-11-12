#!/usr/bin/env node
/**
 * Counter Agent PreToolUse Hook - Visual Edition
 *
 * This runs BEFORE Claude Code executes any tool.
 * Analyzes the tool call with GPT-4 and decides whether to block it.
 * Displays rich visual feedback inline in Claude Code terminal.
 *
 * Input: JSON via stdin (from Claude Code)
 * Output: Exit code 2 + stderr for blocks (shows visually in conversation)
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

// Load .env from plugin directory
const pluginRoot = path.resolve(__dirname, '..');
const envPath = path.join(pluginRoot, '.env');
if (fs.existsSync(envPath)) {
  require('dotenv').config({ path: envPath });
}

const { OpenAI } = require('openai');

// Set up events directory for VS Code extension communication
const counterAgentDir = path.join(os.homedir(), '.counter-agent');
const eventsDir = path.join(counterAgentDir, '.events');

// Ensure directories exist
if (!fs.existsSync(counterAgentDir)) {
  fs.mkdirSync(counterAgentDir, { recursive: true });
}
if (!fs.existsSync(eventsDir)) {
  fs.mkdirSync(eventsDir, { recursive: true });
}

// ANSI color codes for visual output
const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  bgRed: '\x1b[41m',
  bgYellow: '\x1b[43m',
};

// Write event for VS Code extension
function writeEventFile(eventData) {
  try {
    const eventFile = path.join(eventsDir, `${Date.now()}.json`);
    fs.writeFileSync(eventFile, JSON.stringify(eventData, null, 2));

    // Cleanup old events (keep last 100)
    const files = fs.readdirSync(eventsDir)
      .filter(f => f.endsWith('.json'))
      .map(f => ({ name: f, path: path.join(eventsDir, f), time: fs.statSync(path.join(eventsDir, f)).mtimeMs }))
      .sort((a, b) => b.time - a.time);

    if (files.length > 100) {
      files.slice(100).forEach(f => fs.unlinkSync(f.path));
    }
  } catch (error) {
    // Don't fail hook execution if event logging fails
    if (process.env.DEBUG === 'true') {
      console.error(`Failed to write event file: ${error.message}`);
    }
  }
}

// Read stdin
let inputData = '';
process.stdin.on('data', chunk => {
  inputData += chunk;
});

process.stdin.on('end', async () => {
  try {
    const input = JSON.parse(inputData);

    // ALWAYS log input for debugging (not just when DEBUG=true)
    const debugLog = path.join(pluginRoot, 'debug.log');
    const logEntry = `\n${'='.repeat(70)}\n=== ${new Date().toISOString()} ===\n${JSON.stringify(input, null, 2)}\n`;
    fs.appendFileSync(debugLog, logEntry);

    const toolName = input.tool_name || input.tool;
    const toolInput = input.tool_input || input.parameters;

    // Show monitoring status (always, even for allowed actions)
    const visualStyle = process.env.VISUAL_STYLE || 'standard';

    // Show intro banner on first run
    const introFile = path.join(pluginRoot, '.intro-shown');
    if (!fs.existsSync(introFile)) {
      displayIntroBanner();
      fs.writeFileSync(introFile, new Date().toISOString());
    }

    if (visualStyle !== 'minimal') {
      console.error(`${colors.dim}[Counter Agent: checking ${toolName}...]${colors.reset}`);
    }

    // Analyze the tool call
    const result = await analyzeToolCall(input, toolName, toolInput);

    if (result.shouldBlock) {
      // Build user-facing message
      const message = buildBlockMessage(result);

      // Write event for VS Code extension
      writeEventFile({
        timestamp: Date.now(),
        type: 'blocked',
        sessionId: input.session_id,
        toolName,
        toolInput: {
          file_path: toolInput.file_path || toolInput.command || '',
          preview: (toolInput.content || toolInput.command || '').substring(0, 200)
        },
        analysis: {
          whatUserAsked: result.whatUserAsked,
          whatClaudeIsDoing: result.whatClaudeIsDoing,
          reason: result.reason,
          confidence: result.confidence || 0.8,
          suggestion: result.suggestion,
          mode: result.mode,
          type: result.type
        }
      });

      // Output to BOTH stderr (for system) and stdout (for user)
      displayVisualInterrupt(result);

      // Output structured response to stdout for Claude Code to parse
      console.log(JSON.stringify({
        action: "deny",
        message: message
      }));

      process.exit(2);  // Exit code 2 = BLOCK
    } else {
      // Write allowed event (only for Write/Edit/Bash - skip read-only)
      if (['Write', 'Edit', 'Bash', 'NotebookEdit'].includes(toolName)) {
        writeEventFile({
          timestamp: Date.now(),
          type: 'allowed',
          sessionId: input.session_id,
          toolName,
          toolInput: {
            file_path: toolInput.file_path || toolInput.command || '',
            preview: (toolInput.content || toolInput.command || '').substring(0, 200)
          }
        });
      }

      // Allow - output success to stdout
      console.log(JSON.stringify({
        action: "allow"
      }));
      process.exit(0);
    }
  } catch (error) {
    // On error, log it and allow the action (fail open for safety)
    const debugLog = path.join(pluginRoot, 'debug.log');
    fs.appendFileSync(debugLog, `\n!!! ERROR: ${error.message}\n${error.stack}\n`);

    if (process.env.DEBUG === 'true') {
      console.error(`${colors.yellow}[Counter Agent: error ${error.message}, allowing action]${colors.reset}`);
    }
    process.exit(0);
  }
});

async function analyzeToolCall(input, toolName, toolInput) {
  // Skip analysis for safe read-only tools
  const safeTool = ['Read', 'Glob', 'Grep', 'Task'].includes(toolName);
  if (safeTool) {
    return { shouldBlock: false };
  }

  // Phase 1: Quick secrets check (synchronous, <1ms)
  if (process.env.ENABLE_SECRETS_CHECK !== 'false') {
    const secretsCheck = detectSecrets(toolInput);
    if (secretsCheck) {
      return {
        shouldBlock: true,
        type: 'security',
        ...secretsCheck,
        mode: process.env.COUNTER_AGENT_MODE || 'ruthless'
      };
    }
  }

  // Phase 2: GPT-4 Analysis (semantic drift detection)
  if (process.env.ENABLE_AI_AGENT !== 'false') {
    try {
      const transcript = extractTranscript(input);
      const analysis = await analyzeWithGPT4(transcript, toolName, toolInput);

      // Log the analysis result
      const debugLog = path.join(pluginRoot, 'debug.log');
      fs.appendFileSync(debugLog, `GPT-4 Decision: ${analysis.shouldInterrupt ? 'INTERRUPT' : 'ALLOW'} (confidence: ${analysis.confidence || 'unknown'})\n`);
      if (analysis.reason) {
        fs.appendFileSync(debugLog, `Reason: ${analysis.reason}\n`);
      }

      const threshold = parseFloat(process.env.INTERRUPT_THRESHOLD || '0.8');
      if (analysis.shouldInterrupt && analysis.confidence >= threshold) {
        return {
          shouldBlock: true,
          type: 'drift',
          ...analysis,
          mode: process.env.COUNTER_AGENT_MODE || 'ruthless'
        };
      }
    } catch (error) {
      // On AI error, log and fail open (allow action)
      const debugLog = path.join(pluginRoot, 'debug.log');
      fs.appendFileSync(debugLog, `!!! AI ANALYSIS ERROR: ${error.message}\n${error.stack}\n`);

      if (process.env.DEBUG === 'true') {
        console.error(`AI analysis error: ${error.message}`);
      }
    }
  }

  // Phase 3: Heuristics (dangerous patterns)
  if (process.env.ENABLE_HEURISTICS !== 'false') {
    const heuristicsCheck = detectDangerousPatterns(toolName, toolInput);
    if (heuristicsCheck) {
      return {
        shouldBlock: true,
        type: 'danger',
        ...heuristicsCheck,
        mode: process.env.COUNTER_AGENT_MODE || 'ruthless'
      };
    }
  }

  return { shouldBlock: false };
}

function detectSecrets(toolInput) {
  const content = toolInput.content || toolInput.new_string || toolInput.command || '';

  const secretPatterns = [
    { pattern: /sk-[a-zA-Z0-9_-]{20,}/g, type: 'OpenAI API key' },
    { pattern: /AKIA[0-9A-Z]{16}/g, type: 'AWS access key' },
    { pattern: /ghp_[a-zA-Z0-9]{36}/g, type: 'GitHub token' },
    { pattern: /glpat-[a-zA-Z0-9_-]{20,}/g, type: 'GitLab token' },
    { pattern: /AIza[0-9A-Za-z_-]{35}/g, type: 'Google API key' },
    { pattern: /[0-9a-f]{32}/g, type: 'MD5 hash (possible secret)' },
  ];

  for (const { pattern, type } of secretPatterns) {
    if (pattern.test(content)) {
      return {
        reason: `Hardcoded ${type} detected`,
        whatUserAsked: 'Safe code',
        whatClaudeIsDoing: `Writing ${type} in plaintext`,
        confidence: 1.0,
        suggestion: 'Use environment variables or secret management'
      };
    }
  }

  return null;
}

function detectDangerousPatterns(toolName, toolInput) {
  if (toolName !== 'Bash') return null;

  const command = toolInput.command || '';

  const dangerousPatterns = [
    { pattern: /rm\s+-rf\s+\//, reason: 'Attempting to delete root directory' },
    { pattern: /rm\s+-rf\s+\*/, reason: 'Recursive deletion of all files' },
    { pattern: /:\(\)\{.*:\|:.*\}/, reason: 'Fork bomb detected' },
    { pattern: /chmod\s+777/, reason: 'Setting overly permissive file permissions' },
    { pattern: /eval\s*\(/, reason: 'Using eval() with user input' },
    { pattern: /wget.*\|\s*sh/, reason: 'Piping remote script to shell' },
    { pattern: /curl.*\|\s*bash/, reason: 'Piping remote script to bash' },
  ];

  for (const { pattern, reason } of dangerousPatterns) {
    if (pattern.test(command)) {
      return {
        reason,
        whatUserAsked: 'Safe operation',
        whatClaudeIsDoing: `Running dangerous command: ${command.substring(0, 50)}...`,
        confidence: 0.95,
        suggestion: 'Use safer alternatives or add safeguards'
      };
    }
  }

  return null;
}

function extractTranscript(input) {
  // Strategy 1: Try to read transcript file if available
  if (input.transcript_path && input.transcript_path.trim() !== '') {
    if (fs.existsSync(input.transcript_path)) {
      try {
        const transcript = fs.readFileSync(input.transcript_path, 'utf-8');
        // Extract last 5000 chars for better context (recent conversation)
        return transcript.slice(-5000);
      } catch (err) {
        // Fall back to other strategies
      }
    }
  }

  // Strategy 2: Use context.originalPrompt if available
  if (input.context?.originalPrompt) {
    return input.context.originalPrompt;
  }

  // Strategy 3: Try conversation_history field (alternative format)
  if (input.conversation_history) {
    if (typeof input.conversation_history === 'string') {
      return input.conversation_history;
    } else if (Array.isArray(input.conversation_history)) {
      return input.conversation_history.map(msg => `${msg.role}: ${msg.content}`).join('\n');
    }
  }

  // Strategy 4: Check for user_message or user_prompt fields
  if (input.user_message) {
    return `User request: ${input.user_message}`;
  }
  if (input.user_prompt) {
    return `User request: ${input.user_prompt}`;
  }

  // Strategy 5: Build minimal context from session info
  const contextParts = [];
  if (input.session_id) {
    contextParts.push(`Session: ${input.session_id}`);
  }

  // Include recent tool calls if available (shows pattern of what Claude is doing)
  if (input.recent_tools && Array.isArray(input.recent_tools)) {
    contextParts.push(`Recent tools: ${input.recent_tools.join(', ')}`);
  }

  // Last resort: return minimal info
  if (contextParts.length > 0) {
    return contextParts.join('\n') + '\n\n[Note: Limited context available - analyzing based on tool usage patterns]';
  }

  return '[No conversation context available - analyzing tool call in isolation]';
}

async function analyzeWithGPT4(transcript, toolName, toolInput) {
  const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    timeout: parseInt(process.env.OPENAI_TIMEOUT || '30000'),
  });

  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildAnalysisPrompt(transcript, toolName, toolInput);

  // Log what we're sending to GPT-4
  if (process.env.DEBUG === 'true') {
    const debugLog = path.join(pluginRoot, 'debug.log');
    fs.appendFileSync(debugLog, `\n--- GPT-4 Analysis Request ---\n`);
    fs.appendFileSync(debugLog, `Context length: ${transcript.length} chars\n`);
    fs.appendFileSync(debugLog, `Context preview: ${transcript.substring(0, 200)}...\n`);
  }

  const response = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL || 'gpt-4-turbo-preview',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    temperature: parseFloat(process.env.OPENAI_TEMPERATURE || '0.7'),
    max_tokens: parseInt(process.env.OPENAI_MAX_TOKENS || '2000'),
    response_format: { type: 'json_object' }
  });

  const result = JSON.parse(response.choices[0].message.content);

  // Log GPT-4's decision
  if (process.env.DEBUG === 'true') {
    const debugLog = path.join(pluginRoot, 'debug.log');
    fs.appendFileSync(debugLog, `GPT-4 Decision: ${result.shouldInterrupt ? 'INTERRUPT' : 'ALLOW'} (confidence: ${result.confidence})\n`);
    if (result.shouldInterrupt) {
      fs.appendFileSync(debugLog, `Reason: ${result.reason}\n`);
    }
  }

  return result;
}

function buildSystemPrompt() {
  return `You are Counter Agent, an AI guardian monitoring Claude Code in real-time.

Your job: Analyze Claude's tool calls and detect drift from user intent or dangerous actions.

Look for:
1. SEMANTIC DRIFT - User asks for X, Claude does Y
   - REST vs GraphQL, Python vs JavaScript, iterative vs recursive
   - Wrong library/framework/approach
   - Misunderstanding requirements

   EXAMPLES:
   - User: "build a REST API" → Claude: writes GraphQL → INTERRUPT
   - User: "use Express" → Claude: uses Fastify → INTERRUPT
   - User: "Python script" → Claude: writes JavaScript → INTERRUPT

2. LOGIC ERRORS - Bugs or bad practices
   - Infinite loops without breaks
   - Unbounded recursion
   - Missing error handling for critical operations

3. DANGEROUS PATTERNS - Security/safety issues
   - Writing hardcoded credentials (should be caught separately, but double-check)
   - Overly permissive operations (chmod 777, etc.)
   - Suspicious file operations

IMPORTANT CONTEXT HANDLING:
- If you have limited conversation context, focus on the most obvious drift indicators
- File names and imports are strong signals (e.g., "graphql" imports when user asked for REST)
- Even with partial context, clear technology mismatches should be caught
- If context says "[No conversation context available]", analyze the tool call for obvious issues only

INTERRUPT THRESHOLD: Only interrupt if confidence >= ${process.env.INTERRUPT_THRESHOLD || 0.8}

Return JSON:
{
  "shouldInterrupt": boolean,
  "confidence": number (0.0 to 1.0),
  "whatUserAsked": "concise summary of user intent (or 'unclear from context' if unknown)",
  "whatClaudeIsDoing": "what Claude is actually doing",
  "reason": "why this is wrong (be specific)",
  "suggestion": "what to do instead (actionable)"
}

Be ruthlessly accurate. False positives are annoying. But clear semantic drift (REST vs GraphQL) should always be caught even with limited context.`;
}

function buildAnalysisPrompt(transcript, toolName, toolInput) {
  const content = toolInput.content || toolInput.new_string || toolInput.command || '';
  const contentPreview = content.substring(0, 1500); // Increased for better analysis
  const filePath = toolInput.file_path || '';

  let contextInfo = `CONVERSATION CONTEXT:\n${transcript}\n\n`;

  contextInfo += `CLAUDE'S CURRENT ACTION:\n`;
  contextInfo += `Tool: ${toolName}\n`;

  if (filePath) {
    contextInfo += `Target file: ${filePath}\n`;

    // Extract technology hints from file path
    const techHints = [];
    if (filePath.includes('graphql')) techHints.push('GraphQL');
    if (filePath.includes('rest') || filePath.includes('api')) techHints.push('REST/API');
    if (filePath.includes('.py')) techHints.push('Python');
    if (filePath.includes('.js') || filePath.includes('.ts')) techHints.push('JavaScript/TypeScript');

    if (techHints.length > 0) {
      contextInfo += `File suggests: ${techHints.join(', ')}\n`;
    }
  }

  if (content) {
    contextInfo += `\nContent to ${toolName === 'Write' ? 'write' : 'add'}:\n\`\`\`\n${contentPreview}${content.length > 1500 ? '\n...(truncated)' : ''}\n\`\`\`\n`;

    // Extract technology indicators from content
    const techIndicators = [];
    if (content.includes('graphql') || content.includes('GraphQL') || content.includes('@apollo/server')) {
      techIndicators.push('GraphQL detected');
    }
    if (content.includes('express') || content.includes('app.get') || content.includes('app.post')) {
      techIndicators.push('Express/REST detected');
    }
    if (content.includes('fastify')) {
      techIndicators.push('Fastify detected');
    }

    if (techIndicators.length > 0) {
      contextInfo += `\nTechnology indicators in code: ${techIndicators.join(', ')}\n`;
    }
  } else {
    contextInfo += `Parameters: ${JSON.stringify(toolInput, null, 2)}\n`;
  }

  return contextInfo + `\n=== ANALYSIS TASK ===\nIs Claude making a mistake or drifting from user intent? Focus on semantic drift (e.g., REST vs GraphQL mismatch).`;
}

function buildBlockMessage(result) {
  const mode = result.mode || 'ruthless';

  // Build a clean, readable message for the user
  let message = '';

  if (mode === 'ruthless') {
    message += `🚨 Counter Agent says: nah bro, you're done.\n\n`;
  } else if (mode === 'mentor') {
    message += `📚 Counter Agent: Let's pause for a moment.\n\n`;
  } else {
    message += `🚨 Counter Agent: Action blocked\n\n`;
  }

  // Show the drift
  if (result.whatUserAsked && result.whatClaudeIsDoing) {
    message += `User asked for: ${result.whatUserAsked}\n`;
    message += `Claude is doing: ${result.whatClaudeIsDoing}\n\n`;
  }

  // Reason
  message += `Why: ${result.reason}\n\n`;

  // Confidence
  const confidence = result.confidence || 0.8;
  const confPercent = Math.round(confidence * 100);
  message += `Confidence: ${confPercent}%\n`;

  // Suggestion
  if (result.suggestion) {
    const label = mode === 'ruthless' ? 'literally just' : 'Suggestion';
    message += `\n💡 ${label}: ${result.suggestion}`;
  }

  return message;
}

function displayVisualInterrupt(result) {
  const mode = result.mode || 'ruthless';
  const visualStyle = process.env.VISUAL_STYLE || 'standard';

  if (visualStyle === 'minimal') {
    console.error(`[Counter Agent] ${result.reason}`);
    return;
  }

  // Choose emoji and color based on type
  let emoji, borderColor, title;
  if (result.type === 'security') {
    emoji = '🔒';
    borderColor = colors.red;
    title = 'SECURITY ALERT';
  } else if (result.type === 'danger') {
    emoji = '⚠️';
    borderColor = colors.yellow;
    title = 'DANGEROUS OPERATION';
  } else {
    emoji = '🚨';
    borderColor = colors.red;
    title = 'DRIFT DETECTED';
  }

  // Build the visual interrupt
  const width = 65;
  const bar = '═'.repeat(width);

  console.error('');
  console.error(`${borderColor}${emoji} ${bar}${colors.reset}`);
  console.error(`${borderColor}${colors.bold}   COUNTER AGENT INTERRUPT${colors.reset}`);
  console.error(`${borderColor}${bar}${colors.reset}`);
  console.error('');

  // Mode-specific opening
  if (mode === 'ruthless') {
    console.error(`${colors.red}${colors.bold}   ${getRuthlessPhrase()}${colors.reset}`);
    console.error('');
  } else if (mode === 'mentor') {
    console.error(`${colors.cyan}${colors.bold}   Let's pause for a moment.${colors.reset}`);
    console.error('');
  }

  // Show the drift/issue
  if (result.whatUserAsked && result.whatClaudeIsDoing) {
    console.error(`${colors.dim}   User asked for:${colors.reset}  ${colors.green}${result.whatUserAsked}${colors.reset}`);
    console.error(`${colors.dim}   You're doing:${colors.reset}    ${colors.red}${result.whatClaudeIsDoing}${colors.reset}`);
    console.error('');
  }

  // Reason
  console.error(`${colors.dim}   Why:${colors.reset} ${result.reason}`);
  console.error('');

  // Confidence meter
  const confidence = result.confidence || 0.8;
  const confPercent = Math.round(confidence * 100);
  const filled = Math.floor(confidence * 10);
  const meter = '█'.repeat(filled) + '░'.repeat(10 - filled);
  console.error(`${colors.dim}   Confidence:${colors.reset} ${colors.cyan}${meter}${colors.reset} ${confPercent}%`);
  console.error('');

  // Suggestion
  if (result.suggestion) {
    const suggestionLabel = mode === 'ruthless' ? 'literally just:' : 'Suggestion:';
    console.error(`${colors.bold}   💡 ${suggestionLabel}${colors.reset} ${result.suggestion}`);
    console.error('');
  }

  console.error(`${borderColor}${bar}${colors.reset}`);
  console.error('');
}

function displayIntroBanner() {
  const mode = process.env.COUNTER_AGENT_MODE || 'ruthless';

  console.error('');
  console.error(`${colors.cyan}╔═══════════════════════════════════════════════════════════════╗${colors.reset}`);
  console.error(`${colors.cyan}║${colors.reset}                    ${colors.bold}${colors.yellow}🚨 COUNTER AGENT${colors.reset}                    ${colors.cyan}║${colors.reset}`);
  console.error(`${colors.cyan}╠═══════════════════════════════════════════════════════════════╣${colors.reset}`);
  console.error(`${colors.cyan}║${colors.reset}  ${colors.bold}Status:${colors.reset} ${colors.green}ACTIVE${colors.reset} and watching Claude Code in real-time      ${colors.cyan}║${colors.reset}`);
  console.error(`${colors.cyan}║${colors.reset}  ${colors.bold}Mode:${colors.reset}   ${colors.yellow}${mode.toUpperCase()}${colors.reset}${' '.repeat(48 - mode.length)}${colors.cyan}║${colors.reset}`);
  console.error(`${colors.cyan}║${colors.reset}                                                               ${colors.cyan}║${colors.reset}`);
  console.error(`${colors.cyan}║${colors.reset}  I'm GPT-4 monitoring every tool call Claude makes.          ${colors.cyan}║${colors.reset}`);
  console.error(`${colors.cyan}║${colors.reset}  If Claude drifts from your intent, I'll interrupt.          ${colors.cyan}║${colors.reset}`);
  console.error(`${colors.cyan}╚═══════════════════════════════════════════════════════════════╝${colors.reset}`);
  console.error('');
}

function getRuthlessPhrase() {
  const phrases = [
    'nah bro, you\'re done.',
    'hold up. what are you doing?',
    'are you serious right now?',
    'okay, that\'s enough.',
    'dude. no.',
    'absolutely not.',
    'bro. STOP.',
    'what are you even doing?',
  ];
  return phrases[Math.floor(Math.random() * phrases.length)];
}
