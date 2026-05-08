import Link from "next/link";
import { redirect } from "next/navigation";
import { createDocumentDraft, listDocuments } from "@/features/documents/document-repository";

export const dynamic = "force-dynamic";

async function createDocument() {
  "use server";

  const document = await createDocumentDraft("Untitled document");
  redirect(`/documents/${document.id}`);
}

const dateFormatter = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

export default async function DocumentsPage() {
  const documents = await listDocuments();

  return (
    <main className="min-h-screen bg-zinc-50 text-zinc-950">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-10 px-6 py-10 sm:px-8 lg:px-10">
        <header className="flex flex-col gap-6 border-b border-zinc-200 pb-8 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-3xl font-semibold tracking-normal text-zinc-950">Documents</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-zinc-600">
              Business and strategy drafts with AI review history.
            </p>
          </div>
          <form action={createDocument}>
            <button
              type="submit"
              className="inline-flex h-10 items-center justify-center rounded-md bg-zinc-950 px-4 text-sm font-medium text-white transition-colors hover:bg-zinc-800 focus:outline-none focus:ring-2 focus:ring-zinc-950 focus:ring-offset-2"
            >
              New document
            </button>
          </form>
        </header>

        <section className="overflow-hidden border-y border-zinc-200 bg-white">
          {documents.length === 0 ? (
            <p className="px-4 py-12 text-center text-sm text-zinc-500">No documents yet.</p>
          ) : (
            <ul className="divide-y divide-zinc-200">
              {documents.map((document) => {
                const preview = document.plainText.trim() || "No body text";

                return (
                  <li key={document.id}>
                    <Link
                      href={`/documents/${document.id}`}
                      className="grid gap-3 px-4 py-5 transition-colors hover:bg-zinc-50 sm:grid-cols-[1fr_auto] sm:items-center sm:px-5"
                    >
                      <div className="min-w-0">
                        <h2 className="truncate text-base font-medium text-zinc-950">{document.title}</h2>
                        <p className="mt-1 line-clamp-2 text-sm leading-6 text-zinc-600">{preview}</p>
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
