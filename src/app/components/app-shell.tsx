"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { SignOutButton } from "@/app/components/auth-buttons";
import { useAppWorkspace } from "@/app/components/app-workspace-provider";

const primaryNavigation = [
  { href: "/app/dashboard", label: "ダッシュボード", icon: "grid" },
  { href: "/app/analysis", label: "動画分析", icon: "chart" },
  { href: "/app/consult", label: "AIコンサル", icon: "spark" },
  { href: "/app/improvements", label: "改善サイクル", icon: "cycle" },
  { href: "/app/history", label: "履歴", icon: "history" },
] as const;

const secondaryNavigation = [
  { href: "/app/plan", label: "プラン・利用状況", icon: "gauge" },
  { href: "/app/settings", label: "設定", icon: "settings" },
  { href: "/app/support", label: "サポート", icon: "help" },
] as const;

function NavigationIcon({ name }: { name: string }) {
  const paths: Record<string, ReactNode> = {
    grid: <><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></>,
    chart: <><path d="M4 19V9"/><path d="M10 19V5"/><path d="M16 19v-7"/><path d="M22 19V3"/></>,
    spark: <><path d="m12 3 1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3Z"/><path d="m19 15 .8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15Z"/></>,
    cycle: <><path d="M20 7h-5V2"/><path d="M20 7a8 8 0 1 0 1.5 8"/></>,
    history: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
    gauge: <><path d="M4 17a8 8 0 1 1 16 0"/><path d="m12 13 4-4"/><path d="M7 20h10"/></>,
    settings: <><circle cx="12" cy="12" r="3"/><path d="M19 13.5v-3l-2-.7a7 7 0 0 0-.8-1.8l.9-1.9L15 4l-1.9.9a7 7 0 0 0-2.2 0L9 4 6.9 6.1 7.8 8A7 7 0 0 0 7 9.8l-2 .7v3l2 .7a7 7 0 0 0 .8 1.8l-.9 1.9L9 20l1.9-.9a7 7 0 0 0 2.2 0l1.9.9 2.1-2.1-.9-1.9a7 7 0 0 0 .8-1.8l2-.7Z"/></>,
    help: <><circle cx="12" cy="12" r="9"/><path d="M9.8 9a2.4 2.4 0 1 1 3.2 2.3c-.7.3-1 .8-1 1.7"/><path d="M12 17h.01"/></>,
  };
  return <svg className="workspace-nav__icon" viewBox="0 0 24 24" aria-hidden="true">{paths[name]}</svg>;
}

function Navigation({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const renderItems = (items: typeof primaryNavigation | typeof secondaryNavigation) =>
    items.map((item) => {
      const active = pathname === item.href;
      return (
        <Link
          key={item.href}
          href={item.href}
          className={`workspace-nav__link${active ? " workspace-nav__link--active" : ""}`}
          aria-current={active ? "page" : undefined}
          title={item.label}
          onClick={onNavigate}
        >
          <NavigationIcon name={item.icon} />
          <span className="workspace-nav__label">{item.label}</span>
        </Link>
      );
    });

  return (
    <nav className="workspace-nav" aria-label="アプリ内ナビゲーション">
      <div className="workspace-nav__group">{renderItems(primaryNavigation)}</div>
      <div className="workspace-nav__divider" />
      <div className="workspace-nav__group">{renderItems(secondaryNavigation)}</div>
    </nav>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const { user } = useAppWorkspace();
  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const desktopCollapseButtonRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const returnFocusToMobileTriggerRef = useRef(true);

  useEffect(() => {
    if (!drawerOpen) return;
    const previousOverflow = document.body.style.overflow;
    const trigger = menuButtonRef.current;
    const desktopFocusTarget = desktopCollapseButtonRef.current;
    document.body.style.overflow = "hidden";
    const drawer = drawerRef.current;
    const focusable = drawer?.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
    focusable?.[0]?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setDrawerOpen(false);
        return;
      }
      if (event.key !== "Tab" || !focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    const closeAtDesktopWidth = () => {
      if (window.innerWidth >= 768) {
        returnFocusToMobileTriggerRef.current = false;
        setDrawerOpen(false);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", closeAtDesktopWidth);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", closeAtDesktopWidth);
      document.body.style.overflow = previousOverflow;
      if (returnFocusToMobileTriggerRef.current) trigger?.focus();
      else desktopFocusTarget?.focus();
      returnFocusToMobileTriggerRef.current = true;
    };
  }, [drawerOpen]);

  return (
    <div className={`workspace-shell${collapsed ? " workspace-shell--collapsed" : ""}`}>
      <header className="workspace-mobile-header">
        <button
          ref={menuButtonRef}
          className="workspace-icon-button"
          type="button"
          aria-label="メニューを開く"
          aria-expanded={drawerOpen}
          aria-controls="workspace-mobile-drawer"
          onClick={() => {
            returnFocusToMobileTriggerRef.current = true;
            setDrawerOpen(true);
          }}
        >
          <span aria-hidden="true">☰</span>
        </button>
        <Link href="/app/dashboard" className="workspace-brand">ACTUSTUBE</Link>
      </header>

      <aside className="workspace-sidebar" aria-label="サイドバー">
        <div className="workspace-sidebar__header">
          <Link href="/app/dashboard" className="workspace-brand" title="ActusTube">
            <span className="workspace-brand__mark" aria-hidden="true" />
            <span className="workspace-brand__text">ACTUSTUBE</span>
          </Link>
          <button
            ref={desktopCollapseButtonRef}
            className="workspace-collapse-button"
            type="button"
            onClick={() => setCollapsed((value) => !value)}
            aria-label={collapsed ? "サイドバーを展開" : "サイドバーを折りたたむ"}
            aria-expanded={!collapsed}
          >
            <span aria-hidden="true">{collapsed ? "›" : "‹"}</span>
          </button>
        </div>
        <Navigation />
        <div className="workspace-account">
          <span className="workspace-account__avatar" aria-hidden="true">
            {user.name.slice(0, 1).toUpperCase() || "A"}
          </span>
          <div className="workspace-account__copy">
            <strong>{user.name}</strong>
            <span>{user.email}</span>
          </div>
        </div>
      </aside>

      {drawerOpen && (
        <div className="workspace-drawer-layer">
          <button
            type="button"
            className="workspace-drawer-overlay"
            aria-label="メニューを閉じる"
            onClick={() => setDrawerOpen(false)}
          />
          <aside
            ref={drawerRef}
            id="workspace-mobile-drawer"
            className="workspace-drawer"
            role="dialog"
            aria-modal="true"
            aria-label="アプリメニュー"
          >
            <div className="workspace-drawer__header">
              <span className="workspace-brand">ACTUSTUBE</span>
              <button className="workspace-icon-button" type="button" aria-label="メニューを閉じる" onClick={() => setDrawerOpen(false)}>×</button>
            </div>
            <Navigation onNavigate={() => setDrawerOpen(false)} />
            <div className="workspace-drawer__footer"><SignOutButton /></div>
          </aside>
        </div>
      )}

      <main className="workspace-main" id="main-content">{children}</main>
    </div>
  );
}
