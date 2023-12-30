import { render, h, VNode, ComponentChildren, Attributes } from "preact";
import { signal } from "@preact/signals";
import { Metavar, Range, Premise, Diagnostic, Signature} from "./types";

const vscodeApi = acquireVsCodeApi();

const state = {
    metavars: signal<Metavar[]>([]),
    diagnostics: signal<Diagnostic[]>([]),
    signatures: signal<Signature[]>([]),
    uri: signal<string>(''),
};

(window as any).state = state;

const div = (className: string, ...children: ComponentChildren[]) => h('div', { className }, ...children);

function Location(uri: string, range : Range,) {
    console.log('location', uri, range)
    const name = uri.split('/').pop();
    const span = `${range.start.line}:${range.start.character}--${range.end.line}:${range.end.character}`;
    const href = `command:idris2-lsp.select?uri=${encodeURI(uri)}&span=${span}`;
    const onClick = () => vscodeApi.postMessage({select: { uri, range }});
    return h('a', {href, onClick}, name+" "+span);
}

function Premise(prem : Premise) {
    const rig = prem.multiplicity == 'Rig0' ? '0' : prem.multiplicity == 'Rig1' ? '1' : '\xa0';
    return div('premise', `${rig} ${prem.name} : ${prem.type}`);
}

function MetaView({meta}: {meta: Metavar}) {
    
    return div('meta',
        h('div', {style: {margin: "5px 0"}}, Location(meta.location.uri, meta.location.range)),
        div('', ''),
        div('', ...meta.premises.map(Premise)),
        h('div', {style: {borderBottom: "solid 2px black", width: "100px", margin: "5px 0"}}, ''),
        div('', meta.name, ' : ', meta.type));
}

function DiagView({diag}: {diag: Diagnostic}) {
    const [start,end] = diag.range;
    return div('diag', 
        `${diag.severity} -- ${diag.message}`,
        Location(state.uri.value, {start,end})
        );
}

function DiagnosticListView() {
    if (!state.diagnostics.value.length) return null;
    return h('div', {},
        h('h3',{}, 'Diagnostics'),
            state.diagnostics.value.map((diag, key)=> h(DiagView, {diag, key})));
}

function MetaListView() {
    if (!state.metavars.value.length) return null;
    return div('metas', 
        h('h3', {}, 'Holes'),
        state.metavars.value.map((meta, key) => h(MetaView, {meta, key})));
}

function SignatureView(sig: Signature) {
    const lines = sig.documentation.split('\n').map(txt => h('div',{},txt));
    return h('div', {className:'docs'},
        h('h3',{}, `Documentation for ${sig.label}`),
        lines);
}

function SignaturesView() {
    const sigs = state.signatures.value;
    if (!sigs.length) return null;
    return h('div',{}, sigs.map(SignatureView));
}

function App() {
    console.log('APP');
    return h('div', {}, 
        h(SignaturesView,{}),
        h(DiagnosticListView,{}), 
        h(MetaListView, {}));
}

const root = document.getElementById('root');
console.log("will render", root);
render(h(App, {}), root);
console.log('done');

addEventListener("message", (ev) => {
    console.log('message for you sir:', ev.data);
    const {diagnostics, metavars, uri, signatures} = ev.data;
    if (diagnostics) state.diagnostics.value = diagnostics;
    if (metavars) state.metavars.value = metavars;
    if (uri) state.uri.value = uri;
    // probably want to reset on save
    state.signatures.value = signatures ?? [];
});
