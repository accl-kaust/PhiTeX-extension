// The mock's editor: CodeMirror 6 as Overleaf runs it (the same packages,
// Overleaf's LaTeX grammar), so the extension's hook meets a real
// EditorView: `.cm-editor .cm-content`, `cmView`/`cmTile`, update(), setState().
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { LRLanguage, LanguageSupport, syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { styleTags, tags as t } from "@lezer/highlight";
import { parser } from "../build/latex.mjs";

const latex = LRLanguage.define({
  name: "latex",
  parser: parser.configure({
    props: [
      styleTags({
        "CtrlSeq Csname": t.tagName,
        Comment: t.comment,
        "OpenBrace CloseBrace": t.brace,
        "Dollar Math Math/MathChar": t.string,
        "LiteralArgContent VerbContent VerbatimContent LstInlineContent": t.string,
        Number: t.number,
        "EnvName": t.keyword,
      }),
    ],
  }),
});
// (Overleaf's light theme colours, roughly)
const style = HighlightStyle.define([
  { tag: t.tagName, color: "#7b2bb3" },
  { tag: t.comment, color: "#6c7380", fontStyle: "italic" },
  { tag: t.string, color: "#0a6b3d" },
  { tag: t.keyword, color: "#1b4bb3" },
  { tag: t.number, color: "#a35100" },
]);

export { EditorState, EditorView };
export const extensions = (onUpdate) => [
  lineNumbers(),
  highlightActiveLine(),
  drawSelection(),
  history(),
  keymap.of([...defaultKeymap, ...historyKeymap]),
  new LanguageSupport(latex),
  syntaxHighlighting(style),
  EditorView.lineWrapping,
  EditorView.updateListener.of(onUpdate),
  EditorView.theme({ "&": { height: "100%", flex: "1" }, ".cm-scroller": { fontFamily: "ui-monospace, monospace", fontSize: "13px" } }),
];
