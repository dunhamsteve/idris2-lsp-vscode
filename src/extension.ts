import { spawn } from 'child_process';
import {
  workspace,
  ExtensionContext,
  window,
  OutputChannel,
  commands,
  TextEditorEdit,
  TextEditor,
  MarkdownString,
  DecorationRangeBehavior,
  Range,
  CodeAction,
  QuickPickItem,
  WebviewPanel,
  Uri,
  ViewColumn,
  languages,
  Position,
  Selection,
} from 'vscode';

import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  StreamInfo,
} from 'vscode-languageclient/node';

import { Readable } from 'stream';
import * as process from 'process';
import { Message, Signature } from './types';

const baseName = 'Idris 2 LSP';

/*
TODO:
- [x] show errors
- show type at point (scope would be nice..)
- [x] command to show docs.
- [ ] update view when switching files
- [ ] fill in view when C-c C-d pops it?
- [ ] better styling
*/

class InfoViewPanel {
  private static currentPanel : InfoViewPanel | undefined
  public static readonly viewType = 'infoView';
  private readonly _panel: WebviewPanel;
  private readonly _extensionUri: Uri

  private constructor(extensionUri: Uri) {
    this._panel = window.createWebviewPanel(
      InfoViewPanel.viewType,
      'Idris Info View',
      {viewColumn: ViewColumn.Beside, preserveFocus: true},
      {
        enableScripts: true,
        localResourceRoots: [
          Uri.joinPath(extensionUri, 'media'),
          Uri.joinPath(extensionUri, 'out')
        ]
      }
    );
    this._extensionUri = extensionUri;
    this._update();
    this._panel.webview.onDidReceiveMessage(this.didReceiveMessage, this);
    this._panel.onDidDispose(() => this.dispose(), null);
  }

  didReceiveMessage(ev: Message) {
    console.log("MESSAGE", ev);
    if (ev.select) {
      const {uri, range: {start, end}} = ev.select;
      const range = new Range(new Position(start.line, start.character), new Position(end.line, end.character));
      const editor = window.visibleTextEditors.find(editor => editor.document.uri.toString() === uri);
      if (editor) {
        editor.revealRange(range);
        editor.selection = new Selection(range.start, range.end);
      } else {
        window.showTextDocument(Uri.parse(uri), { selection: range, viewColumn: ViewColumn.One });
      }
    }
  }

  dispose() {
    InfoViewPanel.currentPanel = undefined;
    this._panel.dispose(); // ??
  }

  _update() {
    const webview = this._panel.webview;
    const appUri = webview.asWebviewUri(Uri.joinPath(this._extensionUri,'out','infoView.js'));
    const cssUri = webview.asWebviewUri(Uri.joinPath(this._extensionUri,'media','infoView.css'));
    webview.html = `
      <html>
      <head>
          <link rel="stylesheet" href="${cssUri}">
      </head>
      <body>
          <div id="root"></div>
          <script src="${appUri}"></script>
      </body>
  </html>
    `;
  }
  
  static createOrShow(extensionUri: Uri) {
    if (!InfoViewPanel.currentPanel) {
      InfoViewPanel.currentPanel = new InfoViewPanel(extensionUri);
    }
    InfoViewPanel.currentPanel._panel.reveal(ViewColumn.Beside, true);
  }

  static async postMessage(data: any) {
    console.log("POST",data);
    if (InfoViewPanel.currentPanel) {
      const webview = InfoViewPanel.currentPanel._panel.webview;
      await webview.postMessage(data);
    }
  }
  
}


export function activate(context: ExtensionContext) {
  const extensionConfig = workspace.getConfiguration("idris2-lsp");
  const command: string = extensionConfig.get("path") || "";
  const debugChannel = window.createOutputChannel(baseName + ' Server');
  const serverOptions: ServerOptions = () => new Promise<StreamInfo>((resolve, reject) => {
    const serverProcess = spawn(command, [], { cwd: rootPath(), shell: process.platform === 'win32' });
    if (!serverProcess || !serverProcess.pid) {
      return reject(`Launching server using command ${command} failed.`);
    }
    context.subscriptions.push({
      dispose: () => {
        sendExitCommandTo(serverProcess.stdin);
      }
    });

    const stderr = serverProcess.stderr;
    stderr.setEncoding('utf-8');
    stderr.on('data', data => debugChannel.append(data));

    resolve({
      writer: serverProcess.stdin,
      reader: sanitized(serverProcess.stdout, debugChannel),
      detached: true // let us handle the disposal of the server
    });
  });
  const initializationOptions = {
    logSeverity: extensionConfig.get("logSeverity") || "debug",
    logFile: extensionConfig.get("logFile") || "stderr",
    longActionTimeout: extensionConfig.get("longActionTimeout") || 5000,
    maxCodeActionResults: extensionConfig.get("maxCodeActionResults") || 5,
    showImplicits: extensionConfig.get("showImplicits") || false,
    showMachineNames: extensionConfig.get("showMachineNames") || false,
    fullNamespace: extensionConfig.get("fullNamespace") || false,
    briefCompletions: extensionConfig.get("briefCompletions") ?? true,
  };
  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { scheme: 'file', language: 'idris' },
      { scheme: 'file', language: 'markdown', pattern: '**/*.{lidr,idr}.md' },
      { scheme: 'file', language: 'lidr' }
    ],
    initializationOptions: initializationOptions,
  };
  const client = new LanguageClient(
    'idris2-lsp',
    baseName + ' Client',
    serverOptions,
    clientOptions
  );
  client.start();
  context.subscriptions.push({
    dispose: () => {
      client.stop();
    }
  });
  registerCommandHandlersFor(client, context);
}

function registerCommandHandlersFor(client: LanguageClient, context: ExtensionContext) {
  const replDecorationType = window.createTextEditorDecorationType({
    border: '2px inset darkgray',
    borderRadius: '5px',
    after: {
      color: 'darkgray',
    },
    rangeBehavior: DecorationRangeBehavior.ClosedClosed
  });
  let didSave = false;
  context.subscriptions.push(workspace.onDidSaveTextDocument(async (ev) => {
    // This is too early to run the command, stale data comes back.
    // but the notification comes to often and gets in a loop, so we flag
    // and run on the first instance of the notification after save.
    didSave = true;
  }));
  context.subscriptions.push(languages.onDidChangeDiagnostics(async (ev) => {
    console.log("NOTIFY", didSave);
    const activeEditor = window.activeTextEditor;
    if (!activeEditor || !didSave) return;
    const uri = activeEditor.document.uri;
    didSave = false;
    
    // this triggers didChangeDiagnostics...
    // doing this in didSave is too early and doesn't seem to get up to date metadata
    try {
      console.log('GET METAS');
      const metavars = await client.sendRequest("workspace/executeCommand", { command: "metavars", arguments: null });
      console.log('get diagnostics');
      const diagnostics = client.diagnostics.get(uri);
      await InfoViewPanel.postMessage({uri: uri.toString(), diagnostics, metavars});
    } catch (e) {
      console.log("EXCEPT",e);
    }
  }));
  context.subscriptions.push(
    commands.registerTextEditorCommand(
      'idris2-lsp.action',
      async (editor: TextEditor, _edit: TextEditorEdit, arg: {command:string}) => {
        if (editor.document.isDirty) {
          await editor.document.save();
          window.showInformationMessage('Saved file');
        }
        const res = await commands.executeCommand<CodeAction[]>('vscode.executeCodeActionProvider', editor.document.uri, editor.selection);
        console.log("ACTIONS:", typeof arg, arg);
        // emacs has an "add clause" that would be nice to have.
        if (arg.command == 'load') {
          InfoViewPanel.createOrShow(context.extensionUri);
          const uri = editor.document.uri;
          const diagnostics = languages.getDiagnostics(uri);
          console.log('got diagnostics, requesting metas', diagnostics);
          const metavars = await client.sendRequest("workspace/executeCommand", { command: "metavars", arguments: null });
          InfoViewPanel.postMessage({uri: uri.toString(), diagnostics, metavars});
        } else if (arg.command == 'docs') {
          const {line, character} = editor.selection.start;
          const {signatures} = await client.sendRequest<{signatures:Signature[]}>('textDocument/signatureHelp', {
            textDocument: {uri:editor.document.uri.toString()},
            position: {line , character }
          });
          console.log('signatureHelp', res);
          InfoViewPanel.createOrShow(context.extensionUri);
          InfoViewPanel.postMessage({signatures});
        } else if (arg.command == 'refine') {
          const intros = res.filter((x) => x.title.startsWith("Intro "));
          if (intros.length == 1) {
            workspace.applyEdit(intros[0].edit);
          } else if (intros.length) {
            const items: QuickPickItem[] = intros.map((item, index) => ({ label: item.title }));
            const selected = await window.showQuickPick(items, {
              placeHolder: 'Select a refinement'
            });
            if (selected) {
              const item = intros.find(x => x.title == selected.label);
              workspace.applyEdit(item.edit);
            }
          } else {
            window.showInformationMessage('No refinements available');
          }
        } else {
          for (const action of res) {
            console.log("ACTION",action);
            if (arg.command == 'case' && (action.title.startsWith("Case split on") || action.title.startsWith('Make case for'))) {
              workspace.applyEdit(action.edit);
              break;
            }
            if (arg.command == 'with' && action.title.startsWith("Make with for")) {
              workspace.applyEdit(action.edit);
              break;
            }
            if (arg.command == 'auto' && action.title == 'Add clause') {
              workspace.applyEdit(action.edit);
              break;
            }
          }
        }
      }));
  context.subscriptions.push(
    commands.registerCommand(
      'idris2-lsp.infoView',
      () => InfoViewPanel.createOrShow(context.extensionUri)
    )
  );
  context.subscriptions.push(
    commands.registerTextEditorCommand(
      'idris2-lsp.repl.eval',
      (editor: TextEditor, _edit: TextEditorEdit, customCode) => {
        const code: string = customCode || editor.document.getText(editor.selection);
        if (code.length == 0) {
          // clear decorations
          editor.setDecorations(replDecorationType, []);
          return;
        }
        client
          .sendRequest("workspace/executeCommand", { command: "repl", arguments: [code] })
          .then(
            (res) => {
              const code = res as string;
              return {
                hover: new MarkdownString().appendCodeblock(code, 'idris'),
                preview: code
              };
            },
            (e) => {
              const error = `${e}`;
              return {
                hover: new MarkdownString().appendText(error),
                preview: error
              };
            }
          )
          .then((res) => {
            console.log(`>${res.preview}<`);
            editor.setDecorations(
              replDecorationType,
              [{
                range: editor.selection,
                hoverMessage: res.hover,
                renderOptions: {
                  after: {
                    contentText: ' => ' + inlineReplPreviewFor(res.preview) + ' ',
                  },
                }
              }]
            );
          });
      }
    )
  );
}

function inlineReplPreviewFor(res: string) {
  const maxPreviewLength = 80;
  const lines = res.split(/\r?\n/, 2);
  const firstLine = lines[0];
  const ellipsis = '…';
  if (lines.length > 1) {
    return firstLine.substring(0, maxPreviewLength) + ellipsis;
  }
  return firstLine.length > maxPreviewLength
    ? firstLine.substring(0, maxPreviewLength) + ellipsis
    : firstLine;
}

function sendExitCommandTo(server: NodeJS.WritableStream) {
  const command = '{"jsonrpc":"2.0","method":"exit"}';
  server.write(`Content-Length: ${command.length}\r\n\r\n`);
  server.write(command);
}

/**
 * Returns a new stream with spurious content removed, anything between proper
 * [LSP messages](https://microsoft.github.io/language-server-protocol/specifications/specification-3-14/)
 * is discarded.
 * 
 * This is necessary because the Idris 2 core writes error messages directly to stdout.
 *
 * @param source idris2-lsp stdout
 */
function sanitized(source: Readable, debugChannel: OutputChannel): NodeJS.ReadableStream {
  return Readable.from(sanitize(source, debugChannel));
}

async function* sanitize(source: Readable, debugChannel: OutputChannel) {

  let waitingFor = 0;
  let chunks = [];

  for await (const chunk of source) {
    if (waitingFor > 0) {
      // We are already reading a message
      if (chunk.length > waitingFor) {
        const remaining = chunk.subarray(waitingFor);
        chunks.push(remaining);

        const awaited = chunk.subarray(0, waitingFor);
        waitingFor = 0;
        yield awaited;
      }

      waitingFor -= chunk.length;

      yield chunk;
      continue;
    }

    chunks.push(chunk);

    while (chunks.length > 0) {
      const pending = Buffer.concat(chunks);
      const header = findHeader(pending);
      if (header) {
        if (header.begin > 0) {
          debugDiscarded(pending.subarray(0, header.begin));
        }
        const contentLength = header.contentLength;
        const contentEnd = header.end + contentLength;
        const newChunk = pending.subarray(header.begin, contentEnd);
        const headerLength = header.end - header.begin;
        waitingFor = headerLength + contentLength - newChunk.length;
        chunks = waitingFor > 0 ? [] : [pending.subarray(contentEnd)];
        yield newChunk;
      } else {
        // Reuse concat result
        chunks = [pending];
        break;
      }
    }
  }

  function debugDiscarded(discarded: Buffer) {
    debugChannel.appendLine("> STDOUT");
    debugChannel.append(discarded.toString('utf-8'));
    debugChannel.appendLine("< STDOUT");
  }
}

interface ContentHeader {
  begin: number,
  end: number,
  contentLength: number
}

function findHeader(buffer: Buffer): undefined | ContentHeader {
  // Search the buffer for the pattern `Content-Length: \d+\r\n\r\n`
  let searchIndex = 0;
  while (searchIndex < buffer.length) {
    const headerPattern = 'Content-Length: ';
    const separatorPattern = '\r\n\r\n';
    const begin = buffer.indexOf(headerPattern, searchIndex);
    if (begin < 0) {
      break;
    }
    const lengthBegin = begin + headerPattern.length;
    const separatorIndex = buffer.indexOf(separatorPattern, lengthBegin);
    if (separatorIndex > lengthBegin) {
      const lengthBuffer = buffer.subarray(lengthBegin, separatorIndex);
      if (lengthBuffer.every((value, _index, _array) => isDigit(value))) {
        const contentLength = Number.parseInt(lengthBuffer.toString('utf-8'));
        const end = separatorIndex + separatorPattern.length;
        return { begin, end, contentLength };
      }
    }
    searchIndex = lengthBegin;
  }
  return undefined;
}

function isDigit(value: number): boolean {
  return value >= zero && value <= nine;
}

const zero = '0'.charCodeAt(0);

const nine = '9'.charCodeAt(0);

function rootPath(): string | undefined {
  const folders = workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return undefined;
  }
  const folder = folders[0];
  if (folder.uri.scheme === 'file') {
    return folder.uri.fsPath;
  }
  return undefined;
}