import type { EditorMessages } from "@/features/i18n/editor-language";
import type { EditorPlugin, EditorSlashCommand } from "../types";

export const slashMenuPlugin: EditorPlugin = {
  dependencies: ["core.document"],
  id: "navigation.slash-menu",
  name: "Slash menu commands",
  slashCommands: ({ messages }) => createDefaultSlashCommands(messages),
  version: "0.1.0",
};

export function createDefaultSlashCommands(messages: EditorMessages): EditorSlashCommand[] {
  const itemMessages = messages.slashMenu.items;

  return [
    {
      aliases: ["text", "paragraph", "p", "텍스트", "문단"],
      command: (editor, range) => {
        editor.chain().focus().deleteRange(range).setParagraph().run();
      },
      group: "style",
      icon: "type",
      id: "text",
      label: itemMessages.text.label,
      searchText: "text paragraph normal",
      subtext: itemMessages.text.subtext,
    },
    {
      aliases: ["h1", "title", "제목"],
      command: (editor, range) => {
        editor.chain().focus().deleteRange(range).toggleHeading({ level: 1 }).run();
      },
      group: "style",
      icon: "heading-1",
      id: "heading_1",
      label: itemMessages.heading1.label,
      searchText: "heading title h1",
      subtext: itemMessages.heading1.subtext,
    },
    {
      aliases: ["h2", "subtitle", "소제목"],
      command: (editor, range) => {
        editor.chain().focus().deleteRange(range).toggleHeading({ level: 2 }).run();
      },
      group: "style",
      icon: "heading-2",
      id: "heading_2",
      label: itemMessages.heading2.label,
      searchText: "heading subtitle h2",
      subtext: itemMessages.heading2.subtext,
    },
    {
      aliases: ["h3", "section", "섹션"],
      command: (editor, range) => {
        editor.chain().focus().deleteRange(range).toggleHeading({ level: 3 }).run();
      },
      group: "style",
      icon: "heading-3",
      id: "heading_3",
      label: itemMessages.heading3.label,
      searchText: "heading section h3",
      subtext: itemMessages.heading3.subtext,
    },
    {
      aliases: ["bullet", "ul", "list", "목록"],
      command: (editor, range) => {
        editor.chain().focus().deleteRange(range).toggleBulletList().run();
      },
      group: "lists",
      icon: "list",
      id: "bullet_list",
      label: itemMessages.bulletList.label,
      searchText: "bullet unordered list",
      subtext: itemMessages.bulletList.subtext,
    },
    {
      aliases: ["number", "ordered", "ol", "번호"],
      command: (editor, range) => {
        editor.chain().focus().deleteRange(range).toggleOrderedList().run();
      },
      group: "lists",
      icon: "list-ordered",
      id: "ordered_list",
      label: itemMessages.orderedList.label,
      searchText: "number ordered list",
      subtext: itemMessages.orderedList.subtext,
    },
    {
      aliases: ["todo", "task", "check", "체크"],
      command: (editor, range) => {
        editor.chain().focus().deleteRange(range).toggleTaskList().run();
      },
      group: "lists",
      icon: "check-square",
      id: "task_list",
      label: itemMessages.taskList.label,
      searchText: "task todo checklist",
      subtext: itemMessages.taskList.subtext,
    },
    {
      aliases: ["quote", "blockquote", "인용"],
      command: (editor, range) => {
        editor.chain().focus().deleteRange(range).toggleBlockquote().run();
      },
      group: "blocks",
      icon: "quote",
      id: "quote",
      label: itemMessages.quote.label,
      searchText: "quote blockquote",
      subtext: itemMessages.quote.subtext,
    },
    {
      aliases: ["divider", "rule", "line", "hr", "구분선"],
      command: (editor, range) => {
        editor.chain().focus().deleteRange(range).setHorizontalRule().run();
      },
      group: "blocks",
      icon: "minus",
      id: "divider",
      label: itemMessages.divider.label,
      searchText: "divider horizontal rule line",
      subtext: itemMessages.divider.subtext,
    },
    {
      aliases: ["code", "pre", "코드"],
      command: (editor, range) => {
        editor.chain().focus().deleteRange(range).toggleCodeBlock().run();
      },
      group: "blocks",
      icon: "code",
      id: "code_block",
      label: itemMessages.codeBlock.label,
      searchText: "code block pre",
      subtext: itemMessages.codeBlock.subtext,
    },
  ];
}

export function createAiContinueSlashCommand(
  messages: EditorMessages,
  onAiCommand: (command: string) => void,
): EditorSlashCommand {
  const itemMessages = messages.slashMenu.items;

  return {
    aliases: ["ai", "continue", "write", "자동", "이어서"],
    command: (editor, range) => {
      editor.chain().focus().deleteRange(range).run();
      onAiCommand("Continue writing");
    },
    group: "ai",
    icon: "sparkles",
    id: "ai_continue",
    label: itemMessages.aiContinue.label,
    searchText: "ai continue writing",
    subtext: itemMessages.aiContinue.subtext,
  };
}
