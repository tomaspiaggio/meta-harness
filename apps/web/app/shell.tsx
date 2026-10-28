"use client";
import type { Session, Workspace } from "@harness/core";
import type { AgentDefaults } from "@harness/core/models";
import {
  ChevronRight,
  Folder,
  FolderOpen,
  MessageSquare,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  createContext,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

import { AccountMenu } from "./account-menu";
import { DeleteDialog, type DeleteTarget } from "./delete-dialog";
import { refreshPush } from "./push-client";

type Tree = {
  defaults?: AgentDefaults;
  loaded?: boolean;
  workspaces: Workspace[];
  sessions: Session[];
};
const TreeContext = createContext<{
  tree: Tree;
  refresh: () => void;
}>({
  tree: { workspaces: [], sessions: [] },
  refresh: () => {},
});
/** Workspaces and sessions shared by the sidebar and the pages. */
export const useTree = () => useContext(TreeContext);
const sections = [
  { href: "/home", label: "Home" },
  { href: "/", label: "Conversations" },
  { href: "/tasks", label: "Tasks" },
  { href: "/knowledge", label: "Decisions" },
  { href: "/schedules", label: "Schedules" },
  { href: "/settings", label: "Settings" },
];
export function conversationHref(
  workspaceId: string,
  sessionId?: string | null,
) {
  const query = new URLSearchParams({ workspace: workspaceId });
  if (sessionId) query.set("session", sessionId);
  return `/?${query}`;
}
/**
 * A home-screen app keeps running the code it first loaded. After a deploy it
 * would keep calling actions the server no longer has, so reload into the new
 * version when the app comes back to the foreground or sits idle.
 */
function useLatestBuild() {
  useEffect(() => {
    const check = async () => {
      // Dev rebuilds can leave the browser bundle on an older commit id.
      if (document.hidden || process.env.NODE_ENV === "development") return;
      const typing = document.activeElement?.matches("input, textarea");
      try {
        const response = await fetch("/api/version", { cache: "no-store" });
        const { build } = await response.json();
        if (build && build !== process.env.HARNESS_BUILD && !typing)
          location.reload();
      } catch {
        // Offline or mid-deploy: check again later.
      }
    };
    document.addEventListener("visibilitychange", check);
    const timer = setInterval(check, 5 * 60000);
    void check();
    void refreshPush().catch(() => {});
    return () => {
      document.removeEventListener("visibilitychange", check);
      clearInterval(timer);
    };
  }, []);
}

export function Shell({
  children,
  actions,
}: {
  children: React.ReactNode;
  actions?: React.ReactNode;
}) {
  useLatestBuild();
  const pathname = usePathname();
  const section =
    sections.find((item) =>
      item.href === "/" ? pathname === "/" : pathname.startsWith(item.href),
    )?.href ?? "/";
  const [tree, setTree] = useState<Tree>({ workspaces: [], sessions: [] });
  const load = useRef<() => void>(() => {});
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const fetchTree = async () => {
      clearTimeout(timer);
      try {
        if (!document.hidden) {
          const response = await fetch("/api/workspaces", {
            signal: controller.signal,
          });
          if (response.status === 401) {
            location.assign("/login");
            return;
          }
          if (response.ok)
            setTree({ ...(await response.json()), loaded: true });
        }
      } catch {
        // The page shows connection errors; the tree keeps its last value.
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(fetchTree, 15000);
      }
    };
    load.current = () => void fetchTree();
    void fetchTree();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, []);
  const refresh = useCallback(() => load.current(), []);
  return (
    <TreeContext.Provider value={{ tree, refresh }}>
      <SidebarProvider className="fixed inset-0 min-h-0">
        <Suspense fallback={null}>
          <AppSidebar tree={tree} refresh={refresh} />
        </Suspense>
        <SidebarInset className="min-h-0 overflow-hidden">
          <header className="flex h-12 shrink-0 items-center gap-3 border-b px-3 pt-[env(safe-area-inset-top)] box-content">
            <SidebarTrigger className="-ml-1" />
            <span className="min-w-0 truncate text-sm font-medium md:hidden">
              {sections.find((item) => item.href === section)?.label}
            </span>
            <Tabs
              value={section}
              className="hidden min-w-0 overflow-x-auto md:block"
            >
              <TabsList variant="line" className="h-12 w-max gap-0 p-0">
                {sections.map((item) => (
                  <TabsTrigger
                    key={item.href}
                    value={item.href}
                    asChild
                    className="h-full px-3"
                  >
                    <Link href={item.href}>{item.label}</Link>
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
            <div className="ml-auto flex shrink-0 items-center gap-2">
              {actions}
              <AccountMenu />
            </div>
          </header>
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
            {children}
          </div>
        </SidebarInset>
      </SidebarProvider>
    </TreeContext.Provider>
  );
}
function AppSidebar({ tree, refresh }: { tree: Tree; refresh: () => void }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const onConversations = pathname === "/";
  const workspaceId = onConversations
    ? (params.get("workspace") ??
      (tree.loaded ? (tree.workspaces[0]?.id ?? null) : "business"))
    : null;
  const sessionId = onConversations ? params.get("session") : null;
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [error, setError] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [savingTitle, setSavingTitle] = useState(false);
  const [deleting, setDeleting] = useState<DeleteTarget | null>(null);
  const { isMobile, setOpenMobile } = useSidebar();
  const location = `${pathname}?${params}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: close the phone drawer after each navigation
  useEffect(() => {
    if (isMobile) setOpenMobile(false);
  }, [location]);
  return (
    <Sidebar collapsible="offcanvas">
      <DeleteDialog
        target={deleting}
        close={() => setDeleting(null)}
        deleted={(target) => {
          refresh();
          if (target.kind === "workspace" && target.id === workspaceId) {
            const next = tree.workspaces.find(
              (workspace) => workspace.id !== target.id,
            );
            router.replace(next ? conversationHref(next.id) : "/");
          } else if (
            target.kind === "session" &&
            target.id === sessionId &&
            workspaceId
          )
            router.replace(conversationHref(workspaceId));
        }}
      />
      <SidebarHeader className="h-12 justify-center border-b border-sidebar-border px-4">
        <Link href="/" className="flex items-center gap-2.5 font-semibold">
          <span className="grid size-6 place-items-center rounded-md bg-sidebar-primary pb-0.5 font-serif text-lg italic leading-none text-sidebar-primary-foreground">
            m
          </span>
          meta harness
        </Link>
      </SidebarHeader>
      <SidebarContent>
        {isMobile && (
          <SidebarGroup>
            <SidebarMenu>
              {sections.map((item) => (
                <SidebarMenuItem key={item.href}>
                  <SidebarMenuButton
                    asChild
                    isActive={
                      item.href === "/"
                        ? pathname === "/"
                        : pathname.startsWith(item.href)
                    }
                  >
                    <Link href={item.href}>{item.label}</Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroup>
        )}
        <SidebarGroup>
          <SidebarGroupLabel className="font-mono uppercase tracking-wider">
            Workspaces
          </SidebarGroupLabel>
          <SidebarGroupAction
            title="New workspace"
            onClick={() => setCreating(!creating)}
          >
            <Plus />
            <span className="sr-only">New workspace</span>
          </SidebarGroupAction>
          {creating && (
            <form
              className="mb-3 grid gap-2 rounded-lg border border-sidebar-border bg-sidebar-accent p-2"
              onSubmit={async (event) => {
                event.preventDefault();
                setError("");
                const response = await fetch("/api/workspaces", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ name, instructions: purpose }),
                });
                const result = await response.json();
                if (!response.ok) {
                  setError(result.error ?? "Cannot create workspace.");
                  return;
                }
                setCreating(false);
                setName("");
                setPurpose("");
                refresh();
                router.push(conversationHref(result.id));
              }}
            >
              <Input
                aria-label="Workspace name"
                placeholder="Name"
                required
                maxLength={100}
                value={name}
                onChange={(event) => setName(event.target.value)}
                className="h-8 border-sidebar-border bg-sidebar text-sm"
              />
              <Textarea
                aria-label="Workspace purpose"
                placeholder="What is this workspace for?"
                required
                maxLength={10000}
                value={purpose}
                onChange={(event) => setPurpose(event.target.value)}
                className="min-h-16 border-sidebar-border bg-sidebar text-sm"
              />
              {error && <p className="text-xs text-destructive">{error}</p>}
              <div className="flex justify-end gap-1">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="hover:bg-sidebar hover:text-sidebar-foreground"
                  onClick={() => setCreating(false)}
                >
                  Cancel
                </Button>
                <Button type="submit" size="sm">
                  Create
                </Button>
              </div>
            </form>
          )}
          <SidebarMenu>
            {tree.workspaces.map((workspace) => {
              const current = workspace.id === workspaceId;
              const sessions = tree.sessions.filter(
                (session) => session.workspaceId === workspace.id,
              );
              const unread = sessions.reduce(
                (count, session) =>
                  count +
                  (session.unreadCount ?? 0) +
                  (session.needsInputCount ?? 0),
                0,
              );
              const open = expanded[workspace.id] ?? current;
              return (
                <Collapsible
                  key={workspace.id}
                  asChild
                  open={open}
                  onOpenChange={(value) =>
                    setExpanded((state) => ({
                      ...state,
                      [workspace.id]: value,
                    }))
                  }
                >
                  <SidebarMenuItem className="group/workspace">
                    <SidebarMenuButton
                      asChild
                      isActive={current && !sessionId}
                      tooltip={workspace.name}
                      // Leave room for the count badge and both actions.
                      className="pr-28"
                    >
                      <Link
                        href={conversationHref(workspace.id)}
                        onClick={(event) => {
                          // On a phone the drawer closes after navigating, so
                          // a workspace tap only opens its sessions; "New
                          // session" or a session navigates.
                          if (isMobile) event.preventDefault();
                          setExpanded((state) => ({
                            ...state,
                            [workspace.id]: isMobile ? !open : true,
                          }));
                        }}
                      >
                        {open ? <FolderOpen /> : <Folder />}
                        <span className="truncate">{workspace.name}</span>
                      </Link>
                    </SidebarMenuButton>
                    <SidebarMenuBadge
                      title={`${unread} updates needing attention · ${sessions.length} sessions`}
                      className={cn(
                        "right-16 font-mono text-sidebar-foreground/50",
                        unread > 0 && "text-primary",
                      )}
                    >
                      {unread > 0 ? `${unread} new` : sessions.length || ""}
                    </SidebarMenuBadge>
                    <SidebarMenuAction
                      className="right-8 opacity-100 sm:opacity-0 sm:group-hover/workspace:opacity-100 focus-visible:opacity-100"
                      title="Delete workspace"
                      aria-label={`Delete workspace ${workspace.name}`}
                      onClick={() =>
                        setDeleting({
                          kind: "workspace",
                          id: workspace.id,
                          name: workspace.name,
                          sessions: sessions.length,
                        })
                      }
                    >
                      <Trash2 />
                      <span className="sr-only">Delete workspace</span>
                    </SidebarMenuAction>
                    <CollapsibleTrigger asChild>
                      <SidebarMenuAction className="data-[state=open]:rotate-90 transition-transform">
                        <ChevronRight />
                        <span className="sr-only">
                          Show sessions in {workspace.name}
                        </span>
                      </SidebarMenuAction>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <SidebarMenuSub className="mr-0 pr-0">
                        <SidebarMenuSubItem>
                          <SidebarMenuSubButton
                            asChild
                            isActive={current && !sessionId}
                            className="text-sidebar-foreground/60"
                          >
                            <Link href={conversationHref(workspace.id)}>
                              <Plus />
                              <span>New session</span>
                            </Link>
                          </SidebarMenuSubButton>
                        </SidebarMenuSubItem>
                        {sessions.map((session) => (
                          <SidebarMenuSubItem
                            key={session.id}
                            className="group/session relative"
                          >
                            <SidebarMenuSubButton
                              asChild
                              isActive={session.id === sessionId}
                              className="h-auto py-1.5 pr-16"
                            >
                              <Link
                                href={conversationHref(
                                  workspace.id,
                                  session.id,
                                )}
                                title={session.title}
                              >
                                <MessageSquare className="self-start mt-0.5" />
                                <span className="flex min-w-0 flex-col">
                                  <span className="truncate">
                                    {session.title}
                                  </span>
                                  <span className="font-mono text-[10.5px] text-sidebar-foreground/50">
                                    {session.provider} ·{" "}
                                    {timeAgo(
                                      session.lastActivityAt ??
                                        session.createdAt,
                                    )}
                                    {!!session.unreadCount && (
                                      <span className="ml-2 text-primary">
                                        {session.unreadCount} unread
                                      </span>
                                    )}
                                    {!!session.needsInputCount && (
                                      <span className="ml-2 text-warning">
                                        Needs input
                                      </span>
                                    )}
                                  </span>
                                </span>
                              </Link>
                            </SidebarMenuSubButton>
                            <button
                              type="button"
                              aria-label={`Rename ${session.title}`}
                              title="Rename session"
                              className="absolute top-2 right-7 rounded p-1 text-sidebar-foreground/60 opacity-100 hover:bg-sidebar-accent focus-visible:opacity-100 sm:opacity-0 sm:group-hover/session:opacity-100"
                              onClick={() => {
                                setRenaming(session.id);
                                setTitle(session.title);
                                setError("");
                              }}
                            >
                              <Pencil className="size-3" />
                            </button>
                            <button
                              type="button"
                              aria-label={`Delete session ${session.title}`}
                              title="Delete session"
                              className="absolute top-2 right-1 rounded p-1 text-sidebar-foreground/60 opacity-100 hover:bg-sidebar-accent focus-visible:opacity-100 sm:opacity-0 sm:group-hover/session:opacity-100"
                              onClick={() =>
                                setDeleting({
                                  kind: "session",
                                  id: session.id,
                                  name: session.title,
                                })
                              }
                            >
                              <Trash2 className="size-3" />
                            </button>
                            {renaming === session.id && (
                              <form
                                className="mt-1 mb-2 grid gap-2 px-1"
                                onSubmit={async (event) => {
                                  event.preventDefault();
                                  if (savingTitle) return;
                                  setSavingTitle(true);
                                  setError("");
                                  try {
                                    const response = await fetch(
                                      "/api/sessions",
                                      {
                                        method: "PATCH",
                                        headers: {
                                          "Content-Type": "application/json",
                                        },
                                        body: JSON.stringify({
                                          id: session.id,
                                          title,
                                        }),
                                      },
                                    );
                                    const result = await response.json();
                                    if (!response.ok)
                                      throw new Error(
                                        result.error ??
                                          "Could not rename session.",
                                      );
                                    setRenaming(null);
                                    refresh();
                                  } catch (error) {
                                    setError(
                                      error instanceof Error
                                        ? error.message
                                        : "Could not rename session.",
                                    );
                                  } finally {
                                    setSavingTitle(false);
                                  }
                                }}
                              >
                                {error && (
                                  <p
                                    role="alert"
                                    className="text-xs text-destructive"
                                  >
                                    {error}
                                  </p>
                                )}
                                <Input
                                  aria-label="Session name"
                                  value={title}
                                  maxLength={100}
                                  onChange={(event) =>
                                    setTitle(event.target.value)
                                  }
                                  onKeyDown={(event) => {
                                    if (event.key === "Escape")
                                      setRenaming(null);
                                  }}
                                />
                                <div className="flex gap-2">
                                  <Button
                                    size="sm"
                                    disabled={savingTitle || !title.trim()}
                                  >
                                    Save
                                  </Button>
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => setRenaming(null)}
                                  >
                                    Cancel
                                  </Button>
                                </div>
                              </form>
                            )}
                          </SidebarMenuSubItem>
                        ))}
                      </SidebarMenuSub>
                    </CollapsibleContent>
                  </SidebarMenuItem>
                </Collapsible>
              );
            })}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  );
}
const tones: Record<string, string> = {
  running: "bg-live-soft text-live",
  stopping: "bg-warning-soft text-warning",
  queued: "bg-warning-soft text-warning",
  pending: "bg-warning-soft text-warning",
  draining: "bg-warning-soft text-warning",
  completed: "bg-success-soft text-success",
  online: "bg-success-soft text-success",
  failed: "bg-danger-soft text-danger",
  interrupted: "bg-danger-soft text-danger",
};
export function StatusBadge({
  status,
  className,
}: {
  status: string;
  className?: string;
}) {
  return (
    <Badge
      variant="secondary"
      className={cn(
        "gap-1.5 rounded-full border-transparent font-mono normal-case tracking-normal text-[11px] font-normal",
        tones[status] ?? "text-muted-foreground",
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          "size-1.5 rounded-full bg-current",
          status === "running" && "animate-pulse",
        )}
      />
      {status}
    </Badge>
  );
}
export function Meta({
  items,
  className,
}: {
  items: React.ReactNode[];
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] text-muted-foreground",
        className,
      )}
    >
      {items.filter(Boolean).map((item, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static separators
        <span key={index} className="flex items-center gap-2">
          {index > 0 && (
            <span aria-hidden className="text-border">
              ·
            </span>
          )}
          {item}
        </span>
      ))}
    </div>
  );
}
export function PageHeading({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between sm:gap-4">
      <div className="shrink-0">
        <div className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
          {eyebrow}
        </div>
        <h1 className="mt-1 font-serif text-4xl font-normal tracking-tight">
          {title}
        </h1>
      </div>
      {children}
    </div>
  );
}
export function timeAgo(timestamp: number) {
  const seconds = Math.round((Date.now() - timestamp) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}
export function ErrorNote({ children }: { children: React.ReactNode }) {
  return (
    <p
      role="alert"
      className="my-3 rounded-md bg-danger-soft px-3.5 py-2.5 text-sm break-words text-danger"
    >
      {children}
    </p>
  );
}
