import { useEffect, useRef } from 'react';
import Editor, { type BeforeMount, type OnMount } from '@monaco-editor/react';
import type { Diagnostic, Range } from '../../../shared/types.ts';

type Monaco = Parameters<OnMount>[1];
type EditorInstance = Parameters<OnMount>[0];

interface Props {
  path: string;
  value: string;
  diagnostics: Diagnostic[];
  highlight: Range | null;
  onChange: (value: string) => void;
  onCursor: (offset: number) => void;
}

const SEVERITY = { high: 8, medium: 4, low: 2 } as const; // monaco.MarkerSeverity

// Тема редактора повторяет токены интерфейса (styles.css); Monaco принимает только hex.
const defineTheme: BeforeMount = (monaco) => {
  monaco.editor.defineTheme('blueprints', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'keyword', foreground: 'c39dee' },
      { token: 'string', foreground: '7ccd8e' },
      { token: 'number', foreground: 'ebb25f' },
      { token: 'type', foreground: '65c6e4' },
      { token: 'comment', foreground: '737b86', fontStyle: 'italic' },
      { token: 'annotation', foreground: 'ebb25f' },
    ],
    colors: {
      'editor.background': '#0f1318',
      'editor.foreground': '#e4e8ed',
      'editorLineNumber.foreground': '#4d545e',
      'editorLineNumber.activeForeground': '#a9b0ba',
      'editor.lineHighlightBackground': '#171c23',
      'editor.lineHighlightBorder': '#00000000',
      'editor.selectionBackground': '#21344c',
      'editor.inactiveSelectionBackground': '#1a2635',
      'editorCursor.foreground': '#f77e35',
      'editorIndentGuide.background1': '#1e232a',
      'editorIndentGuide.activeBackground1': '#353c46',
      'editorWidget.background': '#171c23',
      'editorWidget.border': '#242931',
      'editorHoverWidget.background': '#171c23',
      'editorHoverWidget.border': '#242931',
      'scrollbarSlider.background': '#2a303980',
      'scrollbarSlider.hoverBackground': '#353c46a0',
      'editorOverviewRuler.border': '#00000000',
    },
  });
};

export function CodeEditor({ path, value, diagnostics, highlight, onChange, onCursor }: Props) {
  const editorRef = useRef<EditorInstance | null>(null);
  const monacoRef = useRef<Monaco | null>(null);
  const decorations = useRef<string[]>([]);
  // Курсор, который поставили мы сами (подсветка из графа), не должен
  // снова выбирать узел — иначе получится цикл граф → код → граф.
  const programmatic = useRef(false);
  const onCursorRef = useRef(onCursor);
  onCursorRef.current = onCursor;

  const handleMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
    // Geist Mono грузится асинхронно — без перемера курсор и выделение съезжают.
    document.fonts.ready.then(() => monaco.editor.remeasureFonts());
    editor.onDidChangeCursorPosition((e) => {
      if (programmatic.current || e.source !== 'mouse') return;
      const offset = editor.getModel()?.getOffsetAt(e.position);
      if (offset !== undefined) onCursorRef.current(offset);
    });
  };

  // Маркеры диагностики.
  useEffect(() => {
    const monaco = monacoRef.current;
    const model = editorRef.current?.getModel();
    if (!monaco || !model) return;
    monaco.editor.setModelMarkers(
      model,
      'dark-secrets',
      diagnostics
        .filter((d) => d.range.file === path)
        .map((d) => {
          const s = model.getPositionAt(d.range.start);
          const e = model.getPositionAt(d.range.end);
          return {
            severity: SEVERITY[d.severity],
            message: `${d.title}: ${d.message}\n→ ${d.recommendation}`,
            startLineNumber: s.lineNumber,
            startColumn: s.column,
            endLineNumber: e.lineNumber,
            endColumn: e.column,
          };
        }),
    );
  }, [diagnostics, path, value]);

  // Подсветка фрагмента, выбранного в графе или в списке проблем.
  useEffect(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    const model = editor?.getModel();
    if (!editor || !monaco || !model) return;
    if (!highlight || highlight.file !== path) {
      decorations.current = editor.deltaDecorations(decorations.current, []);
      return;
    }
    const s = model.getPositionAt(highlight.start);
    const e = model.getPositionAt(highlight.end);
    const range = new monaco.Range(s.lineNumber, s.column, e.lineNumber, e.column);
    decorations.current = editor.deltaDecorations(decorations.current, [
      { range, options: { className: 'code-highlight', isWholeLine: false } },
    ]);
    programmatic.current = true;
    editor.revealRangeInCenterIfOutsideViewport(range);
    programmatic.current = false;
  }, [highlight, path]);

  return (
    <Editor
      path={path}
      language={path.endsWith('.xml') ? 'xml' : 'java'}
      theme="blueprints"
      value={value}
      beforeMount={defineTheme}
      onMount={handleMount}
      onChange={(v) => onChange(v ?? '')}
      options={{
        minimap: { enabled: false },
        fontFamily: "'Geist Mono Variable', ui-monospace, Consolas, monospace",
        fontSize: 13,
        lineHeight: 20,
        padding: { top: 8 },
        scrollBeyondLastLine: false,
        automaticLayout: true,
        tabSize: 4,
        renderLineHighlight: 'line',
        overviewRulerLanes: 2,
        scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
      }}
    />
  );
}
