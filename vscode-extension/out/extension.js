"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const os = require("os");
let panel;
let statusBarItem;
let blockedCount = 0;
let allowedCount = 0;
function activate(context) {
    console.log('Counter Agent extension activated');
    // Create status bar item
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.text = '$(shield) Counter Agent';
    statusBarItem.tooltip = 'Click to show Counter Agent monitor';
    statusBarItem.command = 'counter-agent.showMonitor';
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);
    // Register command to show monitor
    const disposable = vscode.commands.registerCommand('counter-agent.showMonitor', () => {
        showMonitor(context);
    });
    context.subscriptions.push(disposable);
    // Set up file watcher for event files
    const eventsDir = path.join(os.homedir(), '.counter-agent', '.events');
    // Ensure directory exists
    if (!fs.existsSync(eventsDir)) {
        fs.mkdirSync(eventsDir, { recursive: true });
    }
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(eventsDir, '*.json'));
    watcher.onDidCreate(async (uri) => {
        try {
            const content = await fs.promises.readFile(uri.fsPath, 'utf8');
            const event = JSON.parse(content);
            // Update counts
            if (event.type === 'blocked') {
                blockedCount++;
                // Show notification for blocks
                vscode.window.showWarningMessage(`🚨 Counter Agent blocked: ${event.analysis?.reason || 'Unknown reason'}`, 'Show Details').then(selection => {
                    if (selection === 'Show Details') {
                        showMonitor(context);
                    }
                });
            }
            else if (event.type === 'allowed') {
                allowedCount++;
            }
            // Update status bar
            statusBarItem.text = `$(shield) Counter Agent: ${blockedCount} blocked`;
            // Send to webview if open
            if (panel) {
                panel.webview.postMessage({ type: 'newEvent', event });
            }
            // Cleanup file after reading
            setTimeout(() => {
                try {
                    fs.unlinkSync(uri.fsPath);
                }
                catch (err) {
                    // Ignore cleanup errors
                }
            }, 5000);
        }
        catch (error) {
            console.error('Error processing event file:', error);
        }
    });
    context.subscriptions.push(watcher);
}
function showMonitor(context) {
    if (panel) {
        panel.reveal(vscode.ViewColumn.Two);
        return;
    }
    panel = vscode.window.createWebviewPanel('counterAgentMonitor', 'Counter Agent Monitor', vscode.ViewColumn.Two, {
        enableScripts: true,
        retainContextWhenHidden: true
    });
    panel.webview.html = getWebviewContent();
    // Handle disposal
    panel.onDidDispose(() => {
        panel = undefined;
    });
    // Send initial counts
    panel.webview.postMessage({
        type: 'initialCounts',
        blockedCount,
        allowedCount
    });
}
function getWebviewContent() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Counter Agent Monitor</title>
  <style>
    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background-color: var(--vscode-editor-background);
      padding: 20px;
      margin: 0;
    }

    h1 {
      font-size: 24px;
      margin-bottom: 20px;
      border-bottom: 1px solid var(--vscode-panel-border);
      padding-bottom: 10px;
    }

    .stats {
      display: flex;
      gap: 20px;
      margin-bottom: 30px;
      padding: 15px;
      background: var(--vscode-editor-inactiveSelectionBackground);
      border-radius: 5px;
    }

    .stat {
      flex: 1;
    }

    .stat-value {
      font-size: 32px;
      font-weight: bold;
    }

    .stat-label {
      font-size: 12px;
      text-transform: uppercase;
      opacity: 0.7;
    }

    .events {
      margin-top: 20px;
    }

    .event {
      margin-bottom: 15px;
      padding: 15px;
      border-radius: 5px;
      border-left: 4px solid;
    }

    .event.blocked {
      border-left-color: var(--vscode-errorForeground);
      background: var(--vscode-inputValidation-errorBackground);
    }

    .event.allowed {
      border-left-color: var(--vscode-terminal-ansiGreen);
      background: var(--vscode-terminal-background);
      opacity: 0.7;
    }

    .event-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 10px;
    }

    .event-type {
      font-weight: bold;
      font-size: 14px;
    }

    .event-time {
      font-size: 11px;
      opacity: 0.6;
    }

    .event-content {
      font-size: 13px;
    }

    .event-reason {
      margin-top: 8px;
      padding-top: 8px;
      border-top: 1px solid var(--vscode-panel-border);
    }

    .confidence-bar {
      height: 8px;
      background: var(--vscode-progressBar-background);
      border-radius: 4px;
      margin-top: 8px;
      overflow: hidden;
    }

    .confidence-fill {
      height: 100%;
      background: var(--vscode-terminal-ansiYellow);
      transition: width 0.3s;
    }

    .suggestion {
      margin-top: 8px;
      padding: 8px;
      background: var(--vscode-textCodeBlock-background);
      border-radius: 3px;
      font-size: 12px;
    }
  </style>
</head>
<body>
  <h1>🚨 Counter Agent Monitor</h1>

  <div class="stats">
    <div class="stat">
      <div class="stat-value" id="blockedCount">0</div>
      <div class="stat-label">Blocked</div>
    </div>
    <div class="stat">
      <div class="stat-value" id="allowedCount">0</div>
      <div class="stat-label">Allowed</div>
    </div>
  </div>

  <h2>Live Activity</h2>
  <div class="events" id="events"></div>

  <script>
    const vscode = acquireVsCodeApi();
    let blockedCount = 0;
    let allowedCount = 0;

    window.addEventListener('message', event => {
      const message = event.data;

      if (message.type === 'newEvent') {
        addEvent(message.event);
      } else if (message.type === 'initialCounts') {
        blockedCount = message.blockedCount;
        allowedCount = message.allowedCount;
        updateCounts();
      }
    });

    function addEvent(event) {
      const eventsDiv = document.getElementById('events');
      const eventDiv = document.createElement('div');
      eventDiv.className = 'event ' + event.type;

      const time = new Date(event.timestamp).toLocaleTimeString();

      if (event.type === 'blocked') {
        blockedCount++;
        const analysis = event.analysis || {};
        eventDiv.innerHTML = \`
          <div class="event-header">
            <span class="event-type">🚨 BLOCKED - \${event.toolName}</span>
            <span class="event-time">\${time}</span>
          </div>
          <div class="event-content">
            <strong>User asked:</strong> \${analysis.whatUserAsked || 'N/A'}<br>
            <strong>Claude tried:</strong> \${analysis.whatClaudeIsDoing || 'N/A'}
          </div>
          <div class="event-reason">
            <strong>Reason:</strong> \${analysis.reason || 'N/A'}
          </div>
          <div class="confidence-bar">
            <div class="confidence-fill" style="width: \${(analysis.confidence || 0) * 100}%"></div>
          </div>
          <div style="font-size: 11px; margin-top: 4px;">
            Confidence: \${Math.round((analysis.confidence || 0) * 100)}%
          </div>
          \${analysis.suggestion ? \`<div class="suggestion">💡 \${analysis.suggestion}</div>\` : ''}
        \`;
      } else {
        allowedCount++;
        eventDiv.innerHTML = \`
          <div class="event-header">
            <span class="event-type">✅ ALLOWED - \${event.toolName}</span>
            <span class="event-time">\${time}</span>
          </div>
          <div class="event-content">
            \${event.toolInput?.file_path || event.toolInput?.preview || 'Action allowed'}
          </div>
        \`;
      }

      eventsDiv.insertBefore(eventDiv, eventsDiv.firstChild);

      // Keep only last 50 events
      while (eventsDiv.children.length > 50) {
        eventsDiv.removeChild(eventsDiv.lastChild);
      }

      updateCounts();
    }

    function updateCounts() {
      document.getElementById('blockedCount').textContent = blockedCount;
      document.getElementById('allowedCount').textContent = allowedCount;
    }
  </script>
</body>
</html>`;
}
function deactivate() {
    if (panel) {
        panel.dispose();
    }
}
//# sourceMappingURL=extension.js.map