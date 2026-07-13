import Link from "next/link";
import { redirect } from "next/navigation";
import { DocumentImportButton } from "@/components/document/DocumentImportButton";
import { createDocumentDraft, listDocumentSummaries } from "@/features/documents/document-repository";
import {
  InvalidDocumentSummaryFilterError,
  parseDocumentSummaryFilters,
} from "@/features/documents/document-filters";
import type { DocumentReadiness } from "@/db/schema";
import { getProtectedPageContext } from "@/features/auth/route-context";
import { resolveActiveProjectProfile } from "@/features/projects/active-project-profile";
import { createDocumentFilterDefinitions } from "@/features/projects/project-profile";
import { InvalidCollectionCursorError } from "@/features/pagination/collection-cursor";

export const dynamic = "force-dynamic";

async function createDocument() {
  "use server";

  const context = await getProtectedPageContext("/documents");
  const document = await createDocumentDraft(context, "제목 없는 문서");
  redirect(`/documents/${document.id}`);
}

const dateFormatter = new Intl.DateTimeFormat("ko-KR", {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

type DocumentsPageProps = {
  searchParams?: Promise<{
    metadataKey?: string;
    metadataValue?: string;
    cursor?: string;
    query?: string;
    readiness?: string;
  }>;
};

const readinessLabels: Record<DocumentReadiness, string> = {
  approved: "승인됨",
  draft: "초안",
  needs_review: "검토 필요",
  ready: "준비 완료",
};

function getListMetadataValue(value: unknown) {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

export default async function DocumentsPage({ searchParams }: DocumentsPageProps) {
  const context = await getProtectedPageContext("/documents");
  const params = (await searchParams) ?? {};
  const projectProfile = resolveActiveProjectProfile();
  let filterError: string | null = null;
  let page;
  try {
    const filters = parseDocumentSummaryFilters(projectProfile, params);
    page = await listDocumentSummaries(context, { ...filters, cursor: params.cursor, limit: 20 });
  } catch (error) {
    if (!(error instanceof InvalidDocumentSummaryFilterError) && !(error instanceof InvalidCollectionCursorError)) {
      throw error;
    }
    filterError = "페이지 또는 필터 조건이 올바르지 않습니다. 조건을 다시 선택해 주세요.";
    page = { items: [], nextCursor: null };
  }
  const documents = page.items;
  const filterDefinitions = createDocumentFilterDefinitions(projectProfile);
  const selectedFilter = filterDefinitions.find((filter) => filter.id === params.metadataKey);

  return (
    <main className="min-h-screen bg-zinc-50 text-zinc-950">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-10 px-6 py-10 sm:px-8 lg:px-10">
        <header className="flex flex-col gap-6 border-b border-zinc-200 pb-8 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-3xl font-semibold tracking-normal text-zinc-950">문서</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-zinc-600">
              AI 검토 이력을 함께 관리하는 비즈니스 및 전략 문서 초안입니다.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <DocumentImportButton />
            <form action={createDocument}>
              <button
                type="submit"
                className="inline-flex h-10 items-center justify-center rounded-md bg-zinc-950 px-4 text-sm font-medium text-white transition-colors hover:bg-zinc-800 focus:outline-none focus:ring-2 focus:ring-zinc-950 focus:ring-offset-2"
              >
                새 문서
              </button>
            </form>
          </div>
        </header>

        <form
          action="/documents"
          className="grid gap-3 border-y border-zinc-200 bg-white p-4 sm:grid-cols-[minmax(0,1.5fr)_minmax(10rem,0.7fr)_minmax(8rem,0.6fr)_minmax(8rem,0.8fr)_auto]"
        >
          <label className="block">
            <span className="text-xs font-medium text-zinc-500">검색</span>
            <input
              className="mt-1 h-9 w-full rounded-md border border-zinc-200 px-2 text-sm outline-none focus:border-zinc-500"
              defaultValue={params.query ?? ""}
              name="query"
              placeholder="제목 또는 본문"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-zinc-500">준비 상태</span>
            <select
              className="mt-1 h-9 w-full rounded-md border border-zinc-200 bg-white px-2 text-sm outline-none focus:border-zinc-500"
              defaultValue={params.readiness ?? "all"}
              name="readiness"
            >
              <option value="all">전체</option>
              {projectProfile.readiness.map((readiness) => (
                <option key={readiness.id} value={readiness.id}>
                  {readiness.labels.ko}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-xs font-medium text-zinc-500">속성 키</span>
            <select
              className="mt-1 h-9 w-full rounded-md border border-zinc-200 px-2 text-sm outline-none focus:border-zinc-500"
              defaultValue={params.metadataKey ?? ""}
              name="metadataKey"
            >
              <option value="">선택</option>
              {filterDefinitions.map((filter) => <option key={filter.id} value={filter.id}>{filter.labels.ko}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="text-xs font-medium text-zinc-500">속성 값</span>
            {selectedFilter?.type === "select" || selectedFilter?.type === "boolean" ? (
              <select
                className="mt-1 h-9 w-full rounded-md border border-zinc-200 bg-white px-2 text-sm outline-none focus:border-zinc-500"
                defaultValue={params.metadataValue ?? ""}
                name="metadataValue"
              >
                <option value="">선택</option>
                {(selectedFilter.type === "boolean" ? ["true", "false"] : selectedFilter.options ?? []).map((option) => (
                  <option key={option} value={option}>{option}</option>
                ))}
              </select>
            ) : (
              <input
                className="mt-1 h-9 w-full rounded-md border border-zinc-200 px-2 text-sm outline-none focus:border-zinc-500"
                defaultValue={params.metadataValue ?? ""}
                name="metadataValue"
                placeholder="값"
                type={selectedFilter?.type === "date" ? "date" : selectedFilter?.type === "number" ? "number" : "text"}
              />
            )}
          </label>
          <div className="flex items-end">
            <button
              className="h-9 w-full rounded-md bg-zinc-950 px-3 text-sm font-medium text-white hover:bg-zinc-800"
              type="submit"
            >
              필터
            </button>
          </div>
        </form>

        {filterError ? (
          <p className="border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900" role="alert">
            {filterError}
          </p>
        ) : null}

        <section className="overflow-hidden border-y border-zinc-200 bg-white">
          {documents.length === 0 ? (
            <p className="px-4 py-12 text-center text-sm text-zinc-500">
              {filterError ? "일치하는 문서를 표시하지 않았습니다." : "아직 문서가 없습니다."}
            </p>
          ) : (
            <ul className="divide-y divide-zinc-200">
              {documents.map((document) => {
                const preview = document.plainText.trim() || "본문 없음";

                return (
                  <li key={document.id}>
                    <Link
                      href={`/documents/${document.id}`}
                      className="grid gap-3 px-4 py-5 transition-colors hover:bg-zinc-50 sm:grid-cols-[1fr_auto] sm:items-center sm:px-5"
                    >
                      <div className="min-w-0">
                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                          <h2 className="truncate text-base font-medium text-zinc-950">{document.title}</h2>
                          <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-600">
                            {projectProfile.readiness.find((state) => state.id === document.readiness)?.labels.ko ?? readinessLabels[document.readiness]}
                          </span>
                        </div>
                        <p className="mt-1 line-clamp-2 text-sm leading-6 text-zinc-600">{preview}</p>
                        <p className="mt-2 truncate text-xs text-zinc-500">
                          {[
                            getListMetadataValue(document.metadataJson.owner),
                            getListMetadataValue(document.metadataJson.category),
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </p>
                      </div>
                      <time
                        dateTime={document.updatedAt.toISOString()}
                        className="text-xs font-medium uppercase tracking-normal text-zinc-500"
                      >
                        {dateFormatter.format(document.updatedAt)}
                      </time>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
        {page.nextCursor ? (
          <Link
            className="self-center rounded-md border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-100"
            href={`/documents?${createNextPageSearch(params, page.nextCursor)}`}
          >
            다음 문서
          </Link>
        ) : null}
      </div>
    </main>
  );
}

function createNextPageSearch(params: Awaited<NonNullable<DocumentsPageProps["searchParams"]>>, cursor: string) {
  const search = new URLSearchParams();
  for (const key of ["query", "readiness", "metadataKey", "metadataValue"] as const) {
    if (params[key]) search.set(key, params[key]!);
  }
  search.set("cursor", cursor);
  return search.toString();
}
