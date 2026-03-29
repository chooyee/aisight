import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData, Link } from "react-router";
import { eq } from "drizzle-orm";
import { useState, type FormEvent } from "react";
import { getDb } from "~/lib/db/client";
import { entities, entityProfiles, entityAffiliations } from "~/lib/db/schema";
import { AppShell } from "~/components/layout/AppShell";

// ── Colour helpers ────────────────────────────────────────────────────────────

const TYPE_COLOURS: Record<string, string> = {
  company: "#3b82f6",
  regulator: "#f59e0b",
  person: "#10b981",
  instrument: "#8b5cf6",
};

const AFFILIATION_TYPE_LABELS: Record<string, string> = {
  employment: "Employment",
  board: "Board",
  ownership: "Ownership",
  advisory: "Advisory",
  regulatory: "Regulatory",
};

// ── Loader ────────────────────────────────────────────────────────────────────

export async function loader({ params }: LoaderFunctionArgs) {
  const db = getDb();
  const { id } = params;

  const [entity] = await db.select().from(entities).where(eq(entities.id, id!));
  if (!entity) throw new Response("Not Found", { status: 404 });

  const [profile] = await db.select().from(entityProfiles).where(eq(entityProfiles.entityId, id!));

  const affiliationRows = await db
    .select({
      affiliation: entityAffiliations,
      relatedName: entities.name,
      relatedType: entities.type,
    })
    .from(entityAffiliations)
    .leftJoin(entities, eq(entityAffiliations.relatedEntityId, entities.id))
    .where(eq(entityAffiliations.entityId, id!))
    .orderBy(entityAffiliations.isCurrent, entityAffiliations.startDate);

  // Also fetch affiliations where this entity is the "object" (e.g. people who work FOR this company)
  const reverseRows = await db
    .select({
      affiliation: entityAffiliations,
      subjectName: entities.name,
      subjectType: entities.type,
    })
    .from(entityAffiliations)
    .leftJoin(entities, eq(entityAffiliations.entityId, entities.id))
    .where(eq(entityAffiliations.relatedEntityId, id!))
    .orderBy(entityAffiliations.isCurrent, entityAffiliations.startDate);

  // All entities for the affiliation form dropdown
  const allEntities = await db
    .select({ id: entities.id, name: entities.name, type: entities.type })
    .from(entities)
    .orderBy(entities.name)
    .limit(500);

  return {
    entity: {
      ...entity,
      firstSeenAt: entity.firstSeenAt?.toISOString() ?? null,
      createdAt: entity.createdAt.toISOString(),
    },
    profile: profile
      ? {
          ...profile,
          researchedAt: profile.researchedAt?.toISOString() ?? null,
          updatedAt: profile.updatedAt.toISOString(),
          createdAt: profile.createdAt.toISOString(),
        }
      : null,
    affiliations: affiliationRows.map(({ affiliation, relatedName, relatedType }) => ({
      ...affiliation,
      createdAt: affiliation.createdAt.toISOString(),
      updatedAt: affiliation.updatedAt.toISOString(),
      relatedName: relatedName ?? "Unknown",
      relatedType: relatedType ?? "company",
    })),
    reverseAffiliations: reverseRows.map(({ affiliation, subjectName, subjectType }) => ({
      ...affiliation,
      createdAt: affiliation.createdAt.toISOString(),
      updatedAt: affiliation.updatedAt.toISOString(),
      subjectName: subjectName ?? "Unknown",
      subjectType: subjectType ?? "person",
    })),
    allEntities,
  };
}

// ── Types ─────────────────────────────────────────────────────────────────────

type LoaderData = Awaited<ReturnType<typeof loader>>;
type Affiliation = LoaderData["affiliations"][number];
type ReverseAffiliation = LoaderData["reverseAffiliations"][number];

// ── Helpers ───────────────────────────────────────────────────────────────────

function dateBadge(aff: { startDate: string | null; endDate: string | null; isCurrent: boolean }) {
  const s = aff.startDate ?? "?";
  const e = aff.isCurrent ? "Present" : (aff.endDate ?? "?");
  return `${s} – ${e}`;
}

// ── Sub-components ────────────────────────────────────────────────────────────

function AffiliationRow({
  aff,
  direction,
  onDelete,
}: {
  aff: Affiliation | ReverseAffiliation;
  direction: "outgoing" | "incoming";
  onDelete: (id: string) => void;
}) {
  const [deleting, setDeleting] = useState(false);

  const name = direction === "outgoing"
    ? (aff as Affiliation).relatedName
    : (aff as ReverseAffiliation).subjectName;
  const type = direction === "outgoing"
    ? (aff as Affiliation).relatedType
    : (aff as ReverseAffiliation).subjectType;

  const handleDelete = async () => {
    if (!confirm(`Delete this affiliation?`)) return;
    setDeleting(true);
    await fetch(`/api/entities/${aff.entityId}/affiliations`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: aff.id }),
    });
    onDelete(aff.id);
    setDeleting(false);
  };

  return (
    <tr className="border-b border-[var(--color-border)] last:border-0">
      <td className="px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span
            className="text-[10px] px-1.5 py-0.5 rounded font-medium capitalize"
            style={{
              backgroundColor: (TYPE_COLOURS[type] ?? "#64748b") + "25",
              color: TYPE_COLOURS[type] ?? "#94a3b8",
            }}
          >
            {type}
          </span>
          <span className="font-medium text-sm">{name}</span>
        </div>
      </td>
      <td className="px-4 py-2.5">
        <span className="text-xs bg-white/8 text-white/60 px-2 py-0.5 rounded capitalize">
          {AFFILIATION_TYPE_LABELS[aff.affiliationType] ?? aff.affiliationType}
        </span>
      </td>
      <td className="px-4 py-2.5 text-sm text-white/70">
        {aff.role ?? "—"}
        {aff.ownershipPct != null && (
          <span className="ml-1 text-xs text-white/40">({aff.ownershipPct}%)</span>
        )}
      </td>
      <td className="px-4 py-2.5 text-xs text-white/50">{dateBadge(aff)}</td>
      <td className="px-4 py-2.5">
        {aff.isCurrent ? (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-500/15 text-green-400 font-medium">Active</span>
        ) : (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/8 text-white/40">Past</span>
        )}
      </td>
      <td className="px-4 py-2.5">
        <span className={`text-[10px] px-1.5 py-0.5 rounded ${aff.source === "llm_research" ? "bg-purple-500/15 text-purple-400" : "bg-white/8 text-white/40"}`}>
          {aff.source === "llm_research" ? "AI" : "Manual"}
        </span>
      </td>
      <td className="px-4 py-2.5 text-right">
        <button
          onClick={handleDelete}
          disabled={deleting}
          className="text-red-400/60 hover:text-red-400 text-xs cursor-pointer disabled:opacity-40"
        >
          {deleting ? "…" : "Delete"}
        </button>
      </td>
    </tr>
  );
}

function AffiliationForm({
  entityId,
  allEntities,
  onSaved,
  onCancel,
}: {
  entityId: string;
  allEntities: { id: string; name: string; type: string }[];
  onSaved: (aff: Affiliation) => void;
  onCancel: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [affiliationType, setAffiliationType] = useState("employment");
  const [isCurrent, setIsCurrent] = useState(true);

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const payload = {
      relatedEntityId: fd.get("relatedEntityId"),
      affiliationType: fd.get("affiliationType"),
      role: fd.get("role") || null,
      ownershipPct: fd.get("ownershipPct") ? parseFloat(fd.get("ownershipPct") as string) : null,
      startDate: fd.get("startDate") || null,
      endDate: isCurrent ? null : (fd.get("endDate") || null),
      isCurrent,
      notes: fd.get("notes") || null,
      source: "manual",
    };

    setSaving(true);
    const res = await fetch(`/api/entities/${entityId}/affiliations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    setSaving(false);
    if (data.affiliation) onSaved(data.affiliation);
  };

  return (
    <form onSubmit={handleSubmit} className="border border-[var(--color-border)] rounded-lg p-4 space-y-3 bg-[var(--color-surface-1)]/40">
      <p className="text-xs font-medium text-white/60 uppercase tracking-wide">Add Affiliation</p>

      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2">
          <label className="text-xs text-white/50 block mb-1">Related Entity *</label>
          <select
            name="relatedEntityId"
            required
            className="w-full bg-[var(--color-surface-1)] border border-[var(--color-border)] rounded px-2 py-1.5 text-sm text-white/90"
          >
            <option value="">— Select entity —</option>
            {allEntities.filter((e) => e.id !== entityId).map((e) => (
              <option key={e.id} value={e.id}>
                {e.name} ({e.type})
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="text-xs text-white/50 block mb-1">Affiliation Type *</label>
          <select
            name="affiliationType"
            value={affiliationType}
            onChange={(e) => setAffiliationType(e.target.value)}
            className="w-full bg-[var(--color-surface-1)] border border-[var(--color-border)] rounded px-2 py-1.5 text-sm text-white/90"
          >
            <option value="employment">Employment</option>
            <option value="board">Board Member</option>
            <option value="ownership">Ownership</option>
            <option value="advisory">Advisory</option>
            <option value="regulatory">Regulatory</option>
          </select>
        </div>

        <div>
          <label className="text-xs text-white/50 block mb-1">
            {affiliationType === "ownership" ? "Stake / Role" : "Job Title / Role"}
          </label>
          <input
            name="role"
            placeholder={affiliationType === "ownership" ? "e.g. 70% shareholder" : "e.g. CEO, Director"}
            className="w-full bg-[var(--color-surface-1)] border border-[var(--color-border)] rounded px-2 py-1.5 text-sm text-white/90 placeholder:text-white/30"
          />
        </div>

        {affiliationType === "ownership" && (
          <div>
            <label className="text-xs text-white/50 block mb-1">Ownership % (0–100)</label>
            <input
              name="ownershipPct"
              type="number"
              min="0"
              max="100"
              step="0.01"
              placeholder="e.g. 70"
              className="w-full bg-[var(--color-surface-1)] border border-[var(--color-border)] rounded px-2 py-1.5 text-sm text-white/90 placeholder:text-white/30"
            />
          </div>
        )}

        <div>
          <label className="text-xs text-white/50 block mb-1">Start Date</label>
          <input
            name="startDate"
            placeholder="e.g. 2017 or 2017-03"
            className="w-full bg-[var(--color-surface-1)] border border-[var(--color-border)] rounded px-2 py-1.5 text-sm text-white/90 placeholder:text-white/30"
          />
        </div>

        <div>
          <label className="text-xs text-white/50 block mb-1">End Date</label>
          <div className="flex gap-2 items-center">
            <input
              name="endDate"
              placeholder="e.g. 2020 or 2020-12"
              disabled={isCurrent}
              className="flex-1 bg-[var(--color-surface-1)] border border-[var(--color-border)] rounded px-2 py-1.5 text-sm text-white/90 placeholder:text-white/30 disabled:opacity-40"
            />
            <label className="flex items-center gap-1.5 text-xs text-white/50 cursor-pointer whitespace-nowrap">
              <input
                type="checkbox"
                checked={isCurrent}
                onChange={(e) => setIsCurrent(e.target.checked)}
                className="w-3 h-3 rounded accent-[var(--color-accent)]"
              />
              Current
            </label>
          </div>
        </div>

        <div className="col-span-2">
          <label className="text-xs text-white/50 block mb-1">Notes</label>
          <input
            name="notes"
            placeholder="Optional source or context note"
            className="w-full bg-[var(--color-surface-1)] border border-[var(--color-border)] rounded px-2 py-1.5 text-sm text-white/90 placeholder:text-white/30"
          />
        </div>
      </div>

      <div className="flex gap-2 pt-1">
        <button
          type="submit"
          disabled={saving}
          className="bg-[var(--color-accent)] text-white text-sm px-4 py-1.5 rounded hover:opacity-80 disabled:opacity-40 cursor-pointer"
        >
          {saving ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="text-sm px-4 py-1.5 rounded border border-[var(--color-border)] text-white/50 hover:text-white/80 cursor-pointer"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

// ── Profile form ──────────────────────────────────────────────────────────────

function ProfileForm({
  entity,
  profile,
}: {
  entity: LoaderData["entity"];
  profile: LoaderData["profile"];
}) {
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const payload: Record<string, unknown> = {};
    for (const [k, v] of fd.entries()) payload[k] = v || null;

    setSaving(true);
    await fetch(`/api/entities/${entity.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const isPerson = entity.type === "person";
  const isCompanyLike = entity.type === "company" || entity.type === "regulator";

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {/* Basic entity fields */}
      <div>
        <p className="text-xs font-medium text-white/40 uppercase tracking-wide mb-3">Basic Info</p>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-white/50 block mb-1">Sector</label>
            <input
              name="sector"
              defaultValue={entity.sector ?? ""}
              placeholder="e.g. Banking"
              className="w-full bg-[var(--color-surface-1)] border border-[var(--color-border)] rounded px-2 py-1.5 text-sm text-white/90 placeholder:text-white/30"
            />
          </div>
          <div>
            <label className="text-xs text-white/50 block mb-1">Country</label>
            <input
              name="country"
              defaultValue={entity.country ?? ""}
              placeholder="e.g. Malaysia"
              className="w-full bg-[var(--color-surface-1)] border border-[var(--color-border)] rounded px-2 py-1.5 text-sm text-white/90 placeholder:text-white/30"
            />
          </div>
        </div>
      </div>

      {/* Extended profile fields */}
      <div>
        <p className="text-xs font-medium text-white/40 uppercase tracking-wide mb-3">Profile</p>
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2">
            <label className="text-xs text-white/50 block mb-1">Aliases / Alternative Names</label>
            <input
              name="aliases"
              defaultValue={profile?.aliases ?? ""}
              placeholder='e.g. ["Maybank", "MBB"]'
              className="w-full bg-[var(--color-surface-1)] border border-[var(--color-border)] rounded px-2 py-1.5 text-sm text-white/90 placeholder:text-white/30"
            />
            <p className="text-[10px] text-white/30 mt-0.5">Comma-separated names or JSON array</p>
          </div>

          <div className="col-span-2">
            <label className="text-xs text-white/50 block mb-1">Description / Bio</label>
            <textarea
              name="description"
              defaultValue={profile?.description ?? ""}
              rows={3}
              placeholder={isPerson ? "Background, career summary…" : "Company overview, mandate…"}
              className="w-full bg-[var(--color-surface-1)] border border-[var(--color-border)] rounded px-2 py-1.5 text-sm text-white/90 placeholder:text-white/30 resize-none"
            />
          </div>

          <div>
            <label className="text-xs text-white/50 block mb-1">Website</label>
            <input
              name="website"
              defaultValue={profile?.website ?? ""}
              placeholder="https://…"
              className="w-full bg-[var(--color-surface-1)] border border-[var(--color-border)] rounded px-2 py-1.5 text-sm text-white/90 placeholder:text-white/30"
            />
          </div>

          {/* Person-specific */}
          {isPerson && (
            <>
              <div>
                <label className="text-xs text-white/50 block mb-1">Date of Birth</label>
                <input
                  name="dateOfBirth"
                  defaultValue={profile?.dateOfBirth ?? ""}
                  placeholder="YYYY-MM-DD or YYYY"
                  className="w-full bg-[var(--color-surface-1)] border border-[var(--color-border)] rounded px-2 py-1.5 text-sm text-white/90 placeholder:text-white/30"
                />
              </div>
              <div>
                <label className="text-xs text-white/50 block mb-1">Nationality</label>
                <input
                  name="nationality"
                  defaultValue={profile?.nationality ?? ""}
                  placeholder="e.g. Malaysian"
                  className="w-full bg-[var(--color-surface-1)] border border-[var(--color-border)] rounded px-2 py-1.5 text-sm text-white/90 placeholder:text-white/30"
                />
              </div>
              <div>
                <label className="text-xs text-white/50 block mb-1">Gender</label>
                <select
                  name="gender"
                  defaultValue={profile?.gender ?? ""}
                  className="w-full bg-[var(--color-surface-1)] border border-[var(--color-border)] rounded px-2 py-1.5 text-sm text-white/70"
                >
                  <option value="">—</option>
                  <option value="male">Male</option>
                  <option value="female">Female</option>
                  <option value="other">Other</option>
                </select>
              </div>
            </>
          )}

          {/* Company/Regulator-specific */}
          {isCompanyLike && (
            <>
              <div>
                <label className="text-xs text-white/50 block mb-1">Registration No.</label>
                <input
                  name="registrationNo"
                  defaultValue={profile?.registrationNo ?? ""}
                  placeholder="e.g. 813671-W"
                  className="w-full bg-[var(--color-surface-1)] border border-[var(--color-border)] rounded px-2 py-1.5 text-sm text-white/90 placeholder:text-white/30"
                />
              </div>
              <div>
                <label className="text-xs text-white/50 block mb-1">Incorporated Date</label>
                <input
                  name="incorporatedDate"
                  defaultValue={profile?.incorporatedDate ?? ""}
                  placeholder="YYYY-MM-DD or YYYY"
                  className="w-full bg-[var(--color-surface-1)] border border-[var(--color-border)] rounded px-2 py-1.5 text-sm text-white/90 placeholder:text-white/30"
                />
              </div>
              <div>
                <label className="text-xs text-white/50 block mb-1">Jurisdiction</label>
                <input
                  name="jurisdiction"
                  defaultValue={profile?.jurisdiction ?? ""}
                  placeholder="e.g. Malaysia, Labuan"
                  className="w-full bg-[var(--color-surface-1)] border border-[var(--color-border)] rounded px-2 py-1.5 text-sm text-white/90 placeholder:text-white/30"
                />
              </div>
              <div>
                <label className="text-xs text-white/50 block mb-1">Listed Exchange</label>
                <input
                  name="listedExchange"
                  defaultValue={profile?.listedExchange ?? ""}
                  placeholder="e.g. Bursa Malaysia"
                  className="w-full bg-[var(--color-surface-1)] border border-[var(--color-border)] rounded px-2 py-1.5 text-sm text-white/90 placeholder:text-white/30"
                />
              </div>
              <div>
                <label className="text-xs text-white/50 block mb-1">Listed Date</label>
                <input
                  name="listedDate"
                  defaultValue={profile?.listedDate ?? ""}
                  placeholder="YYYY-MM-DD or YYYY"
                  className="w-full bg-[var(--color-surface-1)] border border-[var(--color-border)] rounded px-2 py-1.5 text-sm text-white/90 placeholder:text-white/30"
                />
              </div>
            </>
          )}

          <div className="col-span-2">
            <label className="text-xs text-white/50 block mb-1">Analyst Notes</label>
            <textarea
              name="notes"
              defaultValue={profile?.notes ?? ""}
              rows={2}
              placeholder="Internal notes, caveats, data quality flags…"
              className="w-full bg-[var(--color-surface-1)] border border-[var(--color-border)] rounded px-2 py-1.5 text-sm text-white/90 placeholder:text-white/30 resize-none"
            />
          </div>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={saving}
          className="bg-[var(--color-accent)] text-white text-sm px-5 py-1.5 rounded hover:opacity-80 disabled:opacity-40 cursor-pointer"
        >
          {saving ? "Saving…" : "Save Profile"}
        </button>
        {saved && <span className="text-xs text-green-400">Saved ✓</span>}
      </div>
    </form>
  );
}

// ── AI Research Panel ─────────────────────────────────────────────────────────

function ResearchPanel({
  entity,
  allEntities,
  onAffiliationSaved,
}: {
  entity: LoaderData["entity"];
  allEntities: LoaderData["allEntities"];
  onAffiliationSaved: (aff: Affiliation) => void;
}) {
  type ResearchSuggestion = {
    relatedEntityName: string;
    relatedEntityType: string;
    affiliationType: string;
    role?: string | null;
    ownershipPct?: number | null;
    startDate?: string | null;
    endDate?: string | null;
    isCurrent?: boolean;
    notes?: string | null;
    resolvedEntityId?: string;
    checked: boolean;
    saveState?: "idle" | "saving" | "saved" | "error";
    saveError?: string;
  };

  const [loading, setLoading] = useState(false);
  const [savingAll, setSavingAll] = useState(false);
  const [results, setResults] = useState<ResearchSuggestion[]>([]);
  const [log, setLog] = useState<string>("");

  const entityByName = new Map(
    allEntities.map((e) => [e.name.trim().toLowerCase(), e])
  );

  const handleResearch = async () => {
    setLoading(true);
    setResults([]);
    setLog("Searching...");

    const res = await fetch(`/api/entities/${entity.id}/research`, { method: "POST" });
    const data = await res.json();
    setLoading(false);

    if (data.error) {
      setLog(`Error: ${data.error}`);
      return;
    }

    const affs = (data.affiliations ?? []) as Array<{
      relatedEntityName?: string;
      relatedName?: string;
      relatedEntityType?: string;
      affiliationType: string;
      role?: string | null;
      ownershipPct?: number | null;
      startDate?: string | null;
      endDate?: string | null;
      isCurrent?: boolean;
      notes?: string | null;
    }>;

    const suggestions: ResearchSuggestion[] = affs.map((a) => {
      const relatedEntityName = a.relatedName ?? a.relatedEntityName ?? "Unknown";
      const resolved = entityByName.get(relatedEntityName.trim().toLowerCase());
      return {
        relatedEntityName,
        relatedEntityType: a.relatedEntityType ?? resolved?.type ?? "company",
        affiliationType: a.affiliationType,
        role: a.role ?? null,
        ownershipPct: a.ownershipPct ?? null,
        startDate: a.startDate ?? null,
        endDate: a.endDate ?? null,
        isCurrent: a.isCurrent ?? (a.endDate == null),
        notes: a.notes ?? null,
        resolvedEntityId: resolved?.id,
        checked: true,
        saveState: "idle",
      };
    });

    setResults(suggestions);

    const unmatched = suggestions.filter((s) => !s.resolvedEntityId).length;
    const parts = [`${suggestions.length} suggestion(s) ready`];
    if (unmatched > 0) parts.push(`${unmatched} need entity matching`);
    setLog(data.searchSummary ? `${data.searchSummary} - ${parts.join(", ")}` : parts.join(", "));
  };

  const handleSaveSelected = async () => {
    const toSave = results
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => r.checked && r.saveState !== "saved" && r.saveState !== "saving");

    if (toSave.length === 0) return;

    setSavingAll(true);
    setResults((prev) =>
      prev.map((r, i) =>
        toSave.some(({ i: ti }) => ti === i) ? { ...r, saveState: "saving", saveError: undefined } : r
      )
    );

    await Promise.all(
      toSave.map(async ({ r, i }) => {
        try {
          // If no entity match, create one first
          let resolvedEntityId = r.resolvedEntityId;
          if (!resolvedEntityId) {
            const createRes = await fetch("/api/entities", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ name: r.relatedEntityName, type: r.relatedEntityType }),
            });
            const createData = await createRes.json();
            if (!createRes.ok || !createData.entity?.id) {
              throw new Error(createData.error ?? "Failed to create entity");
            }
            resolvedEntityId = createData.entity.id as string;
          }

          const res = await fetch(`/api/entities/${entity.id}/affiliations`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              relatedEntityId: resolvedEntityId,
              affiliationType: r.affiliationType,
              role: r.role ?? null,
              ownershipPct: r.ownershipPct ?? null,
              startDate: r.startDate ?? null,
              endDate: r.isCurrent ? null : (r.endDate ?? null),
              isCurrent: r.isCurrent ?? (r.endDate == null),
              notes: r.notes ?? null,
              source: "llm_research",
              confidence: 0.8,
            }),
          });

          const data = await res.json();
          if (!res.ok || !data.affiliation) throw new Error(data.error ?? "Save failed");

          setResults((prev) =>
            prev.map((item, idx) => (idx === i ? { ...item, saveState: "saved" } : item))
          );
          onAffiliationSaved(data.affiliation as Affiliation);
        } catch (err) {
          const message = err instanceof Error ? err.message : "Save failed";
          setResults((prev) =>
            prev.map((item, idx) => (idx === i ? { ...item, saveState: "error", saveError: message } : item))
          );
        }
      })
    );

    setSavingAll(false);
  };

  return (
    <div className="border border-[var(--color-border)] rounded-lg p-4 space-y-3 bg-purple-500/5">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium">AI Deep Research</p>
          <p className="text-xs text-white/40 mt-0.5">
            Searches the web and suggests affiliations for <strong>{entity.name}</strong>
          </p>
        </div>
        <button
          onClick={handleResearch}
          disabled={loading}
          className="bg-purple-600 hover:bg-purple-500 text-white text-sm px-4 py-1.5 rounded disabled:opacity-40 cursor-pointer"
        >
          {loading ? "Researching..." : "Research with AI"}
        </button>
      </div>

      {log && <p className="text-xs text-white/50">{log}</p>}

      {results.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-white/60">Check the suggestions you want to save:</p>
          {results.map((r, i) => (
            <div
              key={`${r.relatedEntityName}-${r.affiliationType}-${i}`}
              className={`flex items-start gap-3 p-2.5 rounded border ${r.saveState === "saved" ? "border-green-500/30 bg-green-500/5" : "border-[var(--color-border)]"}`}
            >
              <input
                type="checkbox"
                checked={r.checked}
                disabled={r.saveState === "saved" || r.saveState === "saving"}
                onChange={(e) =>
                  setResults((prev) =>
                    prev.map((item, idx) => (idx === i ? { ...item, checked: e.target.checked } : item))
                  )
                }
                className="mt-0.5 w-3.5 h-3.5 rounded accent-[var(--color-accent)] cursor-pointer disabled:opacity-40 shrink-0"
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium text-sm">{r.relatedEntityName}</span>
                  <span className="text-xs text-white/40 capitalize">{r.affiliationType}</span>
                  {r.role && <span className="text-xs text-white/60">· {r.role}</span>}
                  {r.ownershipPct != null && (
                    <span className="text-xs text-white/60">· {r.ownershipPct}%</span>
                  )}
                  <span className="text-xs text-white/40">
                    {dateBadge({ startDate: r.startDate ?? null, endDate: r.endDate ?? null, isCurrent: r.isCurrent ?? true })}
                  </span>
                  {r.resolvedEntityId ? (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-300">Entity matched</span>
                  ) : (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300">No matching entity</span>
                  )}
                  {r.saveState === "saving" && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/10 text-white/50">Saving…</span>
                  )}
                  {r.saveState === "saved" && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-500/15 text-green-400">Saved ✓</span>
                  )}
                </div>
                {r.notes && <p className="text-[11px] text-white/35 mt-0.5">{r.notes}</p>}
                {r.saveState === "error" && (
                  <p className="text-[11px] text-red-300 mt-0.5">{r.saveError ?? "Save failed"}</p>
                )}
              </div>
            </div>
          ))}

          <div className="flex items-center gap-3 pt-1">
            <button
              onClick={handleSaveSelected}
              disabled={savingAll || !results.some((r) => r.checked && r.saveState !== "saved")}
              className="bg-[var(--color-accent)] text-white text-sm px-4 py-1.5 rounded hover:opacity-80 disabled:opacity-40 cursor-pointer"
            >
              {savingAll ? "Saving…" : "Save Selected"}
            </button>
            <button
              onClick={() => setResults([])}
              className="text-sm text-white/40 hover:text-white/70 cursor-pointer"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
export default function EntityDetailPage() {
  const loaderData = useLoaderData<typeof loader>();
  const { entity, profile, allEntities } = loaderData;

  const [tab, setTab] = useState<"profile" | "affiliations">("profile");
  const [affiliations, setAffiliations] = useState(loaderData.affiliations);
  const [reverseAffiliations] = useState(loaderData.reverseAffiliations);
  const [showAddForm, setShowAddForm] = useState(false);

  const handleAffiliationSaved = (aff: Affiliation) => {
    setAffiliations((prev) => [aff, ...prev]);
    setShowAddForm(false);
  };

  const handleDelete = (id: string) => {
    setAffiliations((prev) => prev.filter((a) => a.id !== id));
  };

  const typeColour = TYPE_COLOURS[entity.type] ?? "#64748b";

  return (
    <AppShell>
      <div className="p-6 max-w-5xl mx-auto">
        {/* Breadcrumb */}
        <div className="flex items-center gap-2 text-xs text-white/40 mb-4">
          <Link to="/entities" className="hover:text-white/70">Entities</Link>
          <span>/</span>
          <span className="text-white/70">{entity.name}</span>
        </div>

        {/* Entity header */}
        <div className="flex items-center gap-4 mb-6">
          <div
            className="w-10 h-10 rounded-full flex items-center justify-center text-lg font-bold"
            style={{ backgroundColor: typeColour + "30", color: typeColour }}
          >
            {entity.name[0]?.toUpperCase()}
          </div>
          <div>
            <h1 className="text-xl font-semibold">{entity.name}</h1>
            <div className="flex items-center gap-2 mt-0.5">
              <span
                className="text-[11px] px-2 py-0.5 rounded font-medium capitalize"
                style={{ backgroundColor: typeColour + "25", color: typeColour }}
              >
                {entity.type}
              </span>
              {entity.sector && <span className="text-xs text-white/40">{entity.sector}</span>}
              {entity.country && <span className="text-xs text-white/40">· {entity.country}</span>}
            </div>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-0 border-b border-[var(--color-border)] mb-6">
          {(["profile", "affiliations"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-2 text-sm capitalize border-b-2 transition-colors cursor-pointer ${
                tab === t
                  ? "border-[var(--color-accent)] text-[var(--color-accent)]"
                  : "border-transparent text-white/50 hover:text-white/80"
              }`}
            >
              {t === "affiliations"
                ? `Affiliations (${affiliations.length + reverseAffiliations.length})`
                : t}
            </button>
          ))}
        </div>

        {/* Profile tab */}
        {tab === "profile" && (
          <ProfileForm entity={entity} profile={profile} />
        )}

        {/* Affiliations tab */}
        {tab === "affiliations" && (
          <div className="space-y-6">
            {/* AI Research */}
            <ResearchPanel
              entity={entity}
              allEntities={allEntities}
              onAffiliationSaved={handleAffiliationSaved}
            />

            {/* Outgoing affiliations (this entity → others) */}
            <div>
              <div className="flex items-center justify-between mb-3">
                <div>
                  <p className="text-sm font-medium">
                    {entity.type === "person" ? "Roles & Positions" : "Subsidiaries & Ownerships"}
                  </p>
                  <p className="text-xs text-white/40 mt-0.5">
                    {entity.type === "person"
                      ? "Companies and organisations this person is/was affiliated with"
                      : "Companies this entity owns or controls"}
                  </p>
                </div>
                <button
                  onClick={() => setShowAddForm(!showAddForm)}
                  className="text-sm px-3 py-1.5 rounded border border-[var(--color-border)] text-white/60 hover:text-white/90 hover:border-[var(--color-accent)] cursor-pointer"
                >
                  + Add
                </button>
              </div>

              {showAddForm && (
                <div className="mb-3">
                  <AffiliationForm
                    entityId={entity.id}
                    allEntities={allEntities}
                    onSaved={handleAffiliationSaved}
                    onCancel={() => setShowAddForm(false)}
                  />
                </div>
              )}

              {affiliations.length > 0 ? (
                <div className="border border-[var(--color-border)] rounded-lg overflow-hidden">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-[var(--color-border)] bg-[var(--color-surface-1)]">
                        <th className="text-left px-4 py-2 text-white/40 font-medium text-xs">Entity</th>
                        <th className="text-left px-4 py-2 text-white/40 font-medium text-xs">Type</th>
                        <th className="text-left px-4 py-2 text-white/40 font-medium text-xs">Role</th>
                        <th className="text-left px-4 py-2 text-white/40 font-medium text-xs">Period</th>
                        <th className="text-left px-4 py-2 text-white/40 font-medium text-xs">Status</th>
                        <th className="text-left px-4 py-2 text-white/40 font-medium text-xs">Source</th>
                        <th className="px-4 py-2"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {affiliations.map((aff) => (
                        <AffiliationRow
                          key={aff.id}
                          aff={aff}
                          direction="outgoing"
                          onDelete={handleDelete}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                !showAddForm && (
                  <div className="text-center py-8 text-white/30 text-sm border border-dashed border-[var(--color-border)] rounded-lg">
                    No affiliations yet. Add manually or use AI Research above.
                  </div>
                )
              )}
            </div>

            {/* Reverse affiliations (others → this entity) */}
            {reverseAffiliations.length > 0 && (
              <div>
                <p className="text-sm font-medium mb-1">
                  {entity.type === "company" || entity.type === "regulator"
                    ? "People & Entities affiliated with this organisation"
                    : "Entities affiliated with this person (reverse)"}
                </p>
                <p className="text-xs text-white/40 mb-3">Read-only — edit from the subject entity's page</p>
                <div className="border border-[var(--color-border)] rounded-lg overflow-hidden">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-[var(--color-border)] bg-[var(--color-surface-1)]">
                        <th className="text-left px-4 py-2 text-white/40 font-medium text-xs">Entity</th>
                        <th className="text-left px-4 py-2 text-white/40 font-medium text-xs">Type</th>
                        <th className="text-left px-4 py-2 text-white/40 font-medium text-xs">Role</th>
                        <th className="text-left px-4 py-2 text-white/40 font-medium text-xs">Period</th>
                        <th className="text-left px-4 py-2 text-white/40 font-medium text-xs">Status</th>
                        <th className="text-left px-4 py-2 text-white/40 font-medium text-xs">Source</th>
                        <th className="px-4 py-2"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {reverseAffiliations.map((aff) => (
                        <AffiliationRow
                          key={aff.id}
                          aff={aff}
                          direction="incoming"
                          onDelete={() => {}}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </AppShell>
  );
}


