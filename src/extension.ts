/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as jmespath from 'jmespath';
import * as opn from 'opn';

import { HoverProvider, Hover, SnippetString, StatusBarAlignment, StatusBarItem, ExtensionContext, TextDocument, TextDocumentChangeEvent, Disposable, TextEditor, Selection, languages, commands, Range, ViewColumn, Position, CancellationToken, ProviderResult, CompletionItem, CompletionList, CompletionItemKind, CompletionItemProvider, window, workspace } from 'vscode';

import { AzService, CompletionKind, Arguments } from './azService';
import { parse, findNode } from './parser';
import { exec } from './utils';

export function activate(context: ExtensionContext) {
    const azService = new AzService(azNotFound);
    context.subscriptions.push(languages.registerCompletionItemProvider('azcli', new AzCompletionItemProvider(azService), ' '));
    context.subscriptions.push(languages.registerHoverProvider('azcli', new AzHoverProvider(azService)));
    context.subscriptions.push(new RunLineInEditor());
    context.subscriptions.push(new StatusBarInfo(azService));
}

const completionKinds: Record<CompletionKind, CompletionItemKind> = {
    group: CompletionItemKind.Module,
    command: CompletionItemKind.Function,
    parameter_name: CompletionItemKind.Variable,
    parameter_value: CompletionItemKind.EnumMember,
    snippet: CompletionItemKind.Snippet
};

class AzCompletionItemProvider implements CompletionItemProvider {

    constructor(private azService: AzService) {
    }

    provideCompletionItems(document: TextDocument, position: Position, token: CancellationToken): ProviderResult<CompletionItem[] | CompletionList> {
        const line = document.lineAt(position);
        const upToCursor = line.text.substr(0, position.character);
        const rawSubcommand = (/^\s*(([^-\s][^\s]*\s+)*)/.exec(upToCursor) || [])[1];
        if (typeof rawSubcommand !== 'string') {
            return Promise.resolve([]);
        }
        const subcommand = rawSubcommand.trim()
            .split(/\s+/);
        const args = this.getArguments(line.text);
        const argument = (/\s(--?[^\s]+)\s+[^-\s]*$/.exec(upToCursor) || [])[1];
        const prefix = (/(^|\s)([^\s]*)$/.exec(upToCursor) || [])[2];
        const lead = /^-*/.exec(prefix)![0];
        return this.azService.getCompletions(subcommand[0] === 'az' ? { subcommand: subcommand.slice(1).join(' '), argument, arguments: args } : {})
            .then(completions => completions.map(({ name, kind, detail, documentation, snippet }) => {
                const item = new CompletionItem(name, completionKinds[kind]);
                if (snippet) {
                    item.insertText = new SnippetString(snippet);
                } else if (lead) {
                    item.insertText = name.substr(lead.length);
                }
                if (detail) {
                    item.detail = detail;
                }
                if (documentation) {
                    item.documentation = documentation;
                }
                item.commitCharacters = [' '];
                return item;
            }));
    }

    private getArguments(line: string) {
        const args: Arguments = {};
        let name: string | undefined;
        for (const match of allMatches(/-[^\s"']*|"[^"]*"|'[^']*'|[^\s"']+/g, line, 0)) {
            if (match.startsWith('-')) {
                name = match as string;
                if (!(name in args)) {
                    args[name] = null;
                }
            } else {
                if (name) {
                    args[name] = match;
                }
                name = undefined;
            }
        }
        return args;
    }
}

class AzHoverProvider implements HoverProvider {

    constructor(private azService: AzService) {
    }

    provideHover(document: TextDocument, position: Position, token: CancellationToken): ProviderResult<Hover> {
        const line = document.lineAt(position.line).text;
        const command = parse(line);
        const list = command.subcommand;
        if (list.length && list[0].text === 'az') {
            const node = findNode(command, position.character);
            if (node) {
                if (node.kind === 'subcommand') {
                    const i = list.indexOf(node);
                    if (i > 0) {
                        const subcommand = list.slice(1, i + 1)
                            .map(node => node.text).join(' ');
                        return this.azService.getHover({ subcommand })
                            .then(text => text && new Hover(text.paragraphs, new Range(position.line, node.offset, position.line, node.offset + node.length)));
                    }
                } else if (node.kind === 'parameter_name') {
                    const subcommand = command.subcommand.slice(1)
                        .map(node => node.text).join(' ');
                    return this.azService.getHover({ subcommand, argument: node.text })
                        .then(text => text && new Hover(text.paragraphs, new Range(position.line, node.offset, position.line, node.offset + node.length)));
                }
            }
        }
    }
}

class RunLineInEditor {

    private resultDocument: TextDocument | undefined;
    private parsedResult: object | undefined;
    private queryEnabled = false;
    private queryEnabledStatus: StatusBarItem;
    private query: string | undefined;
    private disposables: Disposable[] = [];

    constructor() {
        this.disposables.push(commands.registerTextEditorCommand('ms-azurecli.toggleLiveQuery', editor => this.toggleQuery(editor)));
        this.disposables.push(this.queryEnabledStatus = window.createStatusBarItem(StatusBarAlignment.Right));
        this.queryEnabledStatus.text = 'Az Live Query';
        this.queryEnabledStatus.command = 'ms-azurecli.toggleLiveQuery';
        this.disposables.push(commands.registerTextEditorCommand('ms-azurecli.runLineInEditor', editor => this.run(editor)));
        this.disposables.push(workspace.onDidCloseTextDocument(document => this.close(document)));
        this.disposables.push(workspace.onDidChangeTextDocument(event => this.change(event)));
    }

    private run(source: TextEditor) {
        this.parsedResult = undefined;
        this.query = undefined; // TODO
        const cursor = source.selection.active;
        const line = source.document.lineAt(cursor).text;
        return this.findResultDocument()
            .then(document => window.showTextDocument(document, ViewColumn.Two, true))
            .then(target => replaceContent(target, JSON.stringify({ 'Running command': line }) + '\n')
                .then(() => exec(line))
                .then(({ stdout }) => stdout, ({ stdout, stderr }) => JSON.stringify({ stderr, stdout }, null, '    '))
                .then(content => replaceContent(target, content)
                    .then(() => this.parsedResult = JSON.parse(content))
                    .then(undefined, err => {})
                )
            )
            .then(undefined, console.error);
    }

    private toggleQuery(source: TextEditor) {
        this.queryEnabled = !this.queryEnabled;
        this.queryEnabledStatus[this.queryEnabled ? 'show' : 'hide']();
        this.updateResult();
    }

    private findResultDocument() {
        if (this.resultDocument) {
            return Promise.resolve(this.resultDocument);
        }
        return workspace.openTextDocument({ language: 'json' })
            .then(document => this.resultDocument = document);
    }

    private close(document: TextDocument) {
        if (document === this.resultDocument) {
            this.resultDocument = undefined;
        }
    }

    private change(e: TextDocumentChangeEvent) {
        if (e.document.languageId === 'azcli' && e.contentChanges.length === 1) {
            const change = e.contentChanges[0];
            const range = change.range;
            if (range.start.line === range.end.line) {
                const line = e.document.lineAt(range.start.line).text;
                const query = this.getQueryParameter(line);
                if (query !== this.query) {
                    this.query = query;
                    if (this.queryEnabled) {
                        this.updateResult();
                    }
                }
            }
        }
    }

    private updateResult() {
        if (this.resultDocument && this.parsedResult) {
            const resultEditor = window.visibleTextEditors.find(editor => editor.document === this.resultDocument);
            if (resultEditor) {
                try {
                    const result = this.queryEnabled && this.query ? jmespath.search(this.parsedResult, this.query) : this.parsedResult;
                    replaceContent(resultEditor, JSON.stringify(result, null, '    '))
                        .then(undefined, console.error);
                } catch (err) {
                    if (!(err && err.name === 'ParserError')) {
                        // console.error(err); Ignore because jmespath sometimes fails on partial queries.
                    }
                }
            }
        }
    }

    private getQueryParameter(line: string) {
        return (/\s--query\s+("([^"]*)"|'([^']*)'|([^\s"']+))/.exec(line) as string[] || [])
            .filter(group => !!group)[2];
    }

    dispose() {
        this.disposables.forEach(disposable => disposable.dispose());
    }
}

class StatusBarInfo {

    private info: StatusBarItem;
    private timer: NodeJS.Timer;
    private disposables: Disposable[] = [];

    constructor(private azService: AzService) {
        this.disposables.push(this.info = window.createStatusBarItem(StatusBarAlignment.Left));
        this.disposables.push(window.onDidChangeActiveTextEditor(() => this.update()));
        this.disposables.push({ dispose: () => this.timer && clearTimeout(this.timer) });
        this.refresh()
            .catch(console.error);
    }

    public async refresh() {
        if (this.timer) {
            clearTimeout(this.timer);
        }
        const status = await this.azService.getStatus();
        this.info.text = status.message;
        this.update();
        this.timer = setTimeout(() => {
            this.refresh()
                .catch(console.error);
        }, 5000);
    }

    private update() {
        const editor = window.activeTextEditor;
        const show = this.info.text && editor && editor.document.languageId === 'azcli';
        this.info[show ? 'show' : 'hide']();
    }

    dispose() {
        this.disposables.forEach(disposable => disposable.dispose());
    }
}

function allMatches(regex: RegExp, string: string, group: number) {
    return {
        [Symbol.iterator]: function* () {
            let m;
            while (m = regex.exec(string)) {
                yield m[group];
            }
        }
    }
}

function replaceContent(editor: TextEditor, content: string) {
    const document = editor.document;
    const all = new Range(new Position(0, 0), document.lineAt(document.lineCount - 1).range.end);
    return editor.edit(builder => builder.replace(all, content))
        .then(() => editor.selections = [new Selection(0, 0, 0, 0)]);
}

async function azNotFound(): Promise<void> {
    const result = await window.showInformationMessage<any>('\'az\' not found on PATH, make sure it is installed.',
        {
            title: 'Install...',
            run: () => {
                opn('https://aka.ms/GetTheAzureCLI');
            }
        },
        {
            title: 'Close',
            isCloseAffordance: true
        }
    );
    if (result && result.run) {
        result.run();
    }
}

export function deactivate() {
}