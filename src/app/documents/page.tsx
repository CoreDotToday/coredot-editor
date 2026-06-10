import Link from "next/link";
import { redirect } from "next/navigation";
import { DocumentImportButton } from "@/components/document/DocumentImportButton";
import { createDocumentDraft, listDocuments } from "@/features/documents/document-repository";
import { filterDocumentSummaries } from "@/features/documents/document-filters";
import { documentReadinessValues, normalizeDocumentReadiness } from "@/features/documents/document-metadata";
import type { DocumentReadiness } from "@/db/schema";

export const dynamic = "force-dynamic";

async function createDocument() {
  "use server";

  const document = await createDocumentDraft("제목 없는 문서");
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
  const params = (await searchParams) ?? {};
  const documents = filterDocumentSummaries(await listDocuments(), {
    metadataKey: params.metadataKey,
    metadataValue: params.metadataValue,
    query: params.query,
    readiness: params.readiness && params.readiness !== "all" ? normalizeDocumentReadiness(params.readiness) : "all",
  });

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
              {documentReadinessValues.map((readiness) => (
                <option key={readiness} value={readiness}>
                  {readinessLabels[readiness]}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-xs font-medium text-zinc-500">속성 키</span>
            <input
              className="mt-1 h-9 w-full rounded-md border border-zinc-200 px-2 text-sm outline-none focus:border-zinc-500"
              defaultValue={params.metadataKey ?? ""}
              name="metadataKey"
              placeholder="owner"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-zinc-500">속성 값</span>
            <input
              className="mt-1 h-9 w-full rounded-md border border-zinc-200 px-2 text-sm outline-none focus:border-zinc-500"
              defaultValue={params.metadataValue ?? ""}
              name="metadataValue"
              placeholder="Legal"
            />
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

        <section className="overflow-hidden border-y border-zinc-200 bg-white">
          {documents.length === 0 ? (
            <p className="px-4 py-12 text-center text-sm text-zinc-500">아직 문서가 없습니다.</p>
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
                            {readinessLabels[document.readiness]}
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
      </div>
    </main>
  );
}
