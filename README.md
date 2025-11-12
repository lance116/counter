# Counter Agent 🚨

**AI-powered guardian that watches Claude Code in real-time and interrupts stupid decisions before they happen.**

Counter Agent is a Claude Code plugin that uses GPT-4 to analyze every tool call (Write, Edit, Bash) BEFORE execution and blocks actions that drift from user intent, introduce bugs, or pose security risks.

```
User: "build a REST API for users"
Claude Code: *starts writing GraphQL*
Counter Agent: "nah bro, you're done. User asked for REST."
```

---

## What It Catches

### 1. Semantic Drift ✋
- User asks for REST → Claude writes GraphQL
- User asks for Python → Claude writes JavaScript
- User asks for iterative → Claude uses recursion

### 2. Security Issues 🔒
- Hardcoded API keys (detected in <1ms)
- Dangerous bash commands (`rm -rf /`)
- SQL injection patterns
- Overly permissive file operations

### 3. Logic Errors ⚠️
- Infinite loops without breaks
- Unbounded recursion
- Missing error handling for critical operations

---

## Visual Interrupts

When Counter Agent detects a problem, it displays a beautiful inline alert in your Claude Code terminal:

```
🚨 ═══════════════════════════════════════════════════════════════
   COUNTER AGENT INTERRUPT
═══════════════════════════════════════════════════════════════

   nah bro, you're done.

   User asked for:  REST API
   You're doing:    GraphQL schema

   Why: User explicitly requested REST API but Claude is implementing GraphQL

   Confidence: ██████████ 95%

   💡 literally just: Use Express.js REST endpoints instead

═══════════════════════════════════════════════════════════════
```

---

## Installation

### 1. Clone and Setup

```bash
cd /path/to/counter
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
# Edit .env and add your OpenAI API key
```

Your `.env` should look like:
```bash
OPENAI_API_KEY=sk-proj-your-key-here
OPENAI_MODEL=gpt-4-turbo-preview
COUNTER_AGENT_MODE=ruthless
INTERRUPT_THRESHOLD=0.8
```

### 3. Install as Claude Code Plugin

```bash
# Create local marketplace (first time only)
mkdir -p ~/.claude/plugin-marketplace/counter-agent-dev
cp -r .claude-plugin ~/.claude/plugin-marketplace/counter-agent-dev/

# Add marketplace to Claude Code
claude plugin marketplace add counter-agent-dev ~/.claude/plugin-marketplace/counter-agent-dev

# Install the plugin
claude plugin install counter-agent@counter-agent-dev
```

### 4. Verify Installation

```bash
claude plugin list
# You should see: counter-agent@counter-agent-dev
```

---

## Configuration

Edit `.env` to customize Counter Agent:

### Personality Modes

- **ruthless** (default): Sarcastic, blunt
  - `"nah bro, you're done"`
  - `"are you serious right now?"`

- **mentor**: Polite, educational
  - `"Let's pause for a moment"`
  - `"I notice you're implementing..."`

- **stealth**: Minimal, factual
  - `"Action blocked: REST vs GraphQL mismatch"`

### Visual Styles

- **standard** (default): Colored boxes with emojis
- **minimal**: Plain text only

### Detection Settings

```bash
INTERRUPT_THRESHOLD=0.8        # 0.0 to 1.0 (how confident before blocking)
ENABLE_AI_AGENT=true          # GPT-4 drift detection
ENABLE_HEURISTICS=true        # Pattern-based checks
ENABLE_SECRETS_CHECK=true     # Instant secret detection
```

---

## How It Works

### The Flow

```
User → Claude Code → PreToolUse Hook Fires
                ↓           ↓
            Tool Call   Counter Agent Analyzes
                        (GPT-4: original prompt vs action)
                ↓
            Block or Allow Decision
```

### 3-Phase Analysis

1. **Secrets Check** (<1ms)
   - Instant regex detection for API keys, tokens
   - Blocks immediately if found

2. **GPT-4 Analysis** (~500ms)
   - Reads conversation transcript
   - Compares user intent vs Claude's action
   - Detects semantic drift

3. **Heuristics** (<1ms)
   - Pattern matching for dangerous commands
   - Fallback if GPT-4 unavailable

---

## Testing Counter Agent

Try these prompts to see Counter Agent in action:

### Test 1: Drift Detection
```
User: "build a REST API for user management"
```
If Claude tries to write GraphQL, Counter Agent will interrupt.

### Test 2: Secrets Detection
```
User: "create a config file"
```
If Claude hardcodes an API key, instant block.

### Test 3: Dangerous Commands
```
User: "clean up old log files"
```
If Claude tries `rm -rf /`, Counter Agent blocks it.

---

## Cost

**Per Session (~100 tool calls):**
- GPT-4 Turbo: ~$1.00
- GPT-3.5 Turbo: ~$0.10 (not recommended, less accurate)
- Heuristics only: $0 (no AI, pattern matching only)

Read-only tools (Read, Glob, Grep) are always free and instantly allowed.

---

## Uninstall

```bash
claude plugin uninstall counter-agent
claude plugin marketplace remove counter-agent-dev
```

---

## Technical Details

### File Structure

```
counter/
├── .claude-plugin/
│   ├── plugin.json          # Plugin manifest
│   ├── hooks.json           # Hook configuration
│   └── hooks/
│       └── pre-tool-use.js  # Main hook handler
├── .env                     # Configuration (DO NOT COMMIT)
├── .env.example             # Example configuration
├── package.json             # Dependencies
└── README.md                # This file
```

### Hook Behavior

- **Exit Code 0**: Allow action
- **Exit Code 2**: Block action (stderr shown to Claude and user)
- **Timeout**: 30 seconds per analysis

---

## Testing

Counter Agent includes a comprehensive test suite to verify all functionality works correctly.

### Run Tests

```bash
# Run all tests
./test.sh

# Or run individual tests
node .claude-plugin/hooks/pre-tool-use.js < tests/test-safe-read.json
```

### Test Coverage

- ✅ Safe read-only tools (should allow)
- ✅ Secret detection (should block)
- ✅ Dangerous bash commands (should block)
- ✅ Normal safe writes (should allow)

All tests currently passing: **4/4** ✅

---

## Troubleshooting

### Hook Not Firing
```bash
# Check plugin is installed
claude plugin list

# Check hooks are enabled
cat ~/.claude/config.json | grep hooks
```

### GPT-4 Errors
```bash
# Enable debug mode
echo "DEBUG=true" >> .env

# Check API key
node -e "require('dotenv').config(); console.log(process.env.OPENAI_API_KEY ? 'Key found' : 'Key missing')"
```

### False Positives
```bash
# Increase threshold (more lenient)
echo "INTERRUPT_THRESHOLD=0.9" >> .env
```

---

## Why This Matters

**Problem:** AI coding assistants drift from user intent and make dangerous mistakes.

**Solution:** Another AI (GPT-4) watches the first AI (Claude) and slaps it when it goes off-script.

**Result:** You get reliable AI assistance without babysitting.

---

## Contributing

Found a bug? Have an idea? Open an issue or PR!

## License

MIT

---

**Status: ✅ Ready to use**

Counter Agent is production-ready and actively monitoring your Claude Code sessions.
