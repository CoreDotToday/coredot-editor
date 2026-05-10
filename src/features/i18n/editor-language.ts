export type EditorLanguage = "en" | "ko";

export const EDITOR_LANGUAGE_STORAGE_KEY = "coredot-editor-language";

export const editorLanguageOptions: Array<{ label: string; value: EditorLanguage }> = [
  { label: "English", value: "en" },
  { label: "한국어", value: "ko" },
];

export const editorMessages = {
  en: {
    aiReview: {
      accept: "Accept",
      accepted: "Accepted",
      acceptProposal: "Accept proposal for {targetText}",
      insertBelow: "Insert below",
      insertBelowProposal: "Insert below proposal for {targetText}",
      noProposals: "No review proposals yet.",
      pending: "Pending",
      rejected: "Rejected",
      reject: "Reject",
      rejectProposal: "Reject proposal for {targetText}",
      replace: "Replace:",
      replaceAction: "Replace",
      replaceProposal: "Replace proposal for {targetText}",
      reviewDocument: "Review document",
      reviewing: "Reviewing...",
      selectTemplate: "Select a template to review.",
      template: "Template: {templateName}",
      title: "AI Review",
      with: "With:",
    },
    editor: {
      bodyLabel: "Document body",
      characters: "characters",
      placeholder: "Write the memo...",
      titleLabel: "Document title",
      words: "words",
    },
    errors: {
      fillReviewVariables: "Fill required template fields.",
      fillSelectionVariables: "Fill required template fields before running selection AI.",
      reviewFailed: "Review failed. Try again.",
      selectTemplateForSelection: "Select a template before running selection AI.",
      selectionRewriteFailed: "Selection rewrite failed. Try again.",
      updateProposalFailed: "Could not update proposal status.",
    },
    header: {
      language: "Language",
      save: "Save",
      saving: "Saving...",
    },
    history: {
      commandTypes: {
        document_review: "document review",
        selection_rewrite: "selection rewrite",
      },
      empty: "No AI runs yet.",
      statuses: {
        completed: "completed",
        failed: "failed",
        pending: "pending",
        streaming: "streaming",
      },
      title: "History",
    },
    outline: {
      empty: "Headings will appear here as the document develops.",
      title: "Outline",
    },
    saveState: {
      dirty: "Unsaved",
      failed: "Save failed",
      saved: "Saved",
      saving: "Saving",
    },
    selectionCommand: {
      empty: "Select text in the editor to reveal AI commands.",
      last: "Last selection command: {command}",
      running: "Running selection command: {command}",
      selected: "Selected: {selectedText}",
      title: "Selection command",
    },
    selectionMenu: {
      commands: {
        improveClarity: { ariaLabel: "Improve clarity", label: "Improve" },
        makeConcise: { ariaLabel: "Make concise", label: "Concise" },
        makeStrategic: { ariaLabel: "Make more strategic", label: "Strategic" },
        strengthenEvidence: { ariaLabel: "Strengthen evidence", label: "Evidence" },
        translateEnglish: { ariaLabel: "Translate to English", label: "English" },
        translateKorean: { ariaLabel: "Translate to Korean", label: "Korean" },
      },
      running: "Running {command}...",
      toolbarLabel: "Selection AI actions",
    },
    templates: {
      empty: "No active templates.",
      promptTemplateLabel: "Prompt template",
      selectPlaceholder: "Select...",
      title: "Templates",
      variableLabels: {
        audience: "Audience",
        objective: "Document objective",
        tone: "Tone",
      },
      variables: "Variables",
    },
  },
  ko: {
    aiReview: {
      accept: "수락",
      accepted: "수락됨",
      acceptProposal: "{targetText} 제안 수락",
      insertBelow: "아래에 추가",
      insertBelowProposal: "{targetText} 제안을 아래에 추가",
      noProposals: "아직 검토 제안이 없습니다.",
      pending: "대기 중",
      rejected: "거절됨",
      reject: "거절",
      rejectProposal: "{targetText} 제안 거절",
      replace: "바꿀 내용:",
      replaceAction: "교체",
      replaceProposal: "{targetText} 제안으로 교체",
      reviewDocument: "문서 검토",
      reviewing: "검토 중...",
      selectTemplate: "검토할 템플릿을 선택하세요.",
      template: "템플릿: {templateName}",
      title: "AI 검토",
      with: "제안 내용:",
    },
    editor: {
      bodyLabel: "문서 본문",
      characters: "글자",
      placeholder: "메모를 작성하세요...",
      titleLabel: "문서 제목",
      words: "단어",
    },
    errors: {
      fillReviewVariables: "필수 템플릿 필드를 입력하세요.",
      fillSelectionVariables: "선택 AI 실행 전에 필수 템플릿 필드를 입력하세요.",
      reviewFailed: "검토에 실패했습니다. 다시 시도하세요.",
      selectTemplateForSelection: "선택 AI를 실행하기 전에 템플릿을 선택하세요.",
      selectionRewriteFailed: "선택 영역 처리에 실패했습니다. 다시 시도하세요.",
      updateProposalFailed: "제안 상태를 업데이트하지 못했습니다.",
    },
    header: {
      language: "언어",
      save: "저장",
      saving: "저장 중...",
    },
    history: {
      commandTypes: {
        document_review: "문서 검토",
        selection_rewrite: "선택 영역 처리",
      },
      empty: "아직 AI 실행 기록이 없습니다.",
      statuses: {
        completed: "완료",
        failed: "실패",
        pending: "대기 중",
        streaming: "진행 중",
      },
      title: "기록",
    },
    outline: {
      empty: "문서가 작성되면 제목이 여기에 표시됩니다.",
      title: "개요",
    },
    saveState: {
      dirty: "저장되지 않음",
      failed: "저장 실패",
      saved: "저장됨",
      saving: "저장 중",
    },
    selectionCommand: {
      empty: "텍스트를 선택하면 AI 명령이 표시됩니다.",
      last: "마지막 선택 명령: {command}",
      running: "선택 명령 실행 중: {command}",
      selected: "선택됨: {selectedText}",
      title: "선택 명령",
    },
    selectionMenu: {
      commands: {
        improveClarity: { ariaLabel: "명확하게 개선", label: "개선" },
        makeConcise: { ariaLabel: "간결하게 만들기", label: "간결" },
        makeStrategic: { ariaLabel: "더 전략적으로 만들기", label: "전략" },
        strengthenEvidence: { ariaLabel: "근거 강화", label: "근거" },
        translateEnglish: { ariaLabel: "영어로 번역", label: "영어" },
        translateKorean: { ariaLabel: "한국어로 번역", label: "한국어" },
      },
      running: "{command} 실행 중...",
      toolbarLabel: "선택 AI 작업",
    },
    templates: {
      empty: "활성 템플릿이 없습니다.",
      promptTemplateLabel: "프롬프트 템플릿",
      selectPlaceholder: "선택...",
      title: "템플릿",
      variableLabels: {
        audience: "대상 독자",
        objective: "문서 목표",
        tone: "톤",
      },
      variables: "변수",
    },
  },
} as const;

export type EditorMessages = (typeof editorMessages)[EditorLanguage];

export function isEditorLanguage(value: string | null): value is EditorLanguage {
  return value === "en" || value === "ko";
}

export function formatEditorMessage(template: string, values: Record<string, string>) {
  return Object.entries(values).reduce((message, [key, value]) => message.replace(`{${key}}`, value), template);
}
