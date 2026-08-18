import { Circle, CircleCheck, CircleDot, ListTodo } from "lucide-react";
import { useMemo } from "react";
import { useT } from "../../lib/i18n/use-t";
import { useAppStore } from "../../lib/stores/app-store";
import { extractLatestTodos, type TodoItem } from "./todo-model";

export function todoNumber(item: TodoItem, todos: readonly TodoItem[]): number {
  const index = todos.findIndex((candidate) => candidate.id === item.id);
  return index >= 0 ? index + 1 : 0;
}

export function TodoRow({
  item,
  active,
  number,
}: {
  item: TodoItem;
  active: boolean;
  number: number;
}) {
  const t = useT();
  const text = item.status === "in_progress" && item.activeForm ? item.activeForm : item.content;
  const Icon =
    item.status === "completed" ? CircleCheck : item.status === "in_progress" ? CircleDot : Circle;
  const statusLabel =
    item.status === "completed"
      ? t("todoStatusCompleted")
      : item.status === "in_progress"
        ? t("todoStatusInProgress")
        : t("todoStatusPending");

  return (
    <li
      data-todo-status={item.status}
      className={`flex min-w-0 items-center gap-2 rounded-md px-2 py-1 text-sm ${
        active ? "bg-surface-overlay/70" : ""
      }`}
      title={`${statusLabel}\n${text}`}
    >
      <span
        aria-hidden="true"
        className={`w-5 shrink-0 text-right font-mono text-xs tabular-nums ${
          item.status === "completed" ? "text-muted/70" : "text-muted"
        }`}
      >
        #{number}
      </span>
      <Icon
        size={15}
        aria-hidden="true"
        className={`shrink-0 ${
          item.status === "completed"
            ? "text-success"
            : item.status === "in_progress"
              ? "text-accent"
              : "text-muted"
        }`}
      />
      <span
        className={`min-w-0 flex-1 truncate leading-4 ${
          item.status === "completed" ? "text-muted line-through" : "text-foreground"
        }`}
        title={text}
      >
        {text}
      </span>
    </li>
  );
}

export function TodoPanel() {
  const t = useT();
  const session = useAppStore((state) => state.session);
  const todos = useMemo(() => extractLatestTodos(session), [session]);

  if (!session) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center text-muted">
        <ListTodo size={28} strokeWidth={1.5} />
        <p className="text-sm">{t("todoNoSession")}</p>
      </div>
    );
  }

  if (todos.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center text-muted">
        <ListTodo size={28} strokeWidth={1.5} />
        <div>
          <p className="text-sm text-foreground">{t("todoEmptyTitle")}</p>
          <p className="mt-1 text-xs">{t("todoEmptyBody")}</p>
        </div>
      </div>
    );
  }

  const activeCount = todos.filter((item) => item.status !== "completed").length;

  return (
    <section aria-label={t("dockTodo")} className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between border-b border-border px-3 py-3">
        <div className="flex items-center gap-2">
          <ListTodo size={16} className="text-accent" />
          <h2 className="text-left text-sm font-medium text-foreground">{t("todoCurrentTitle")}</h2>
        </div>
        <span className="rounded-full bg-surface-overlay px-2 py-0.5 text-xs text-muted">
          {activeCount}
        </span>
      </div>
      <div className="scrollbar-auto-hide min-h-0 flex-1 overflow-y-auto p-2">
        <ul className="flex flex-col gap-0.5" aria-label={t("todoActiveTitle")}>
          {todos.map((item) => (
            <TodoRow
              key={item.id}
              item={item}
              number={todoNumber(item, todos)}
              active={item.status === "in_progress"}
            />
          ))}
        </ul>
      </div>
    </section>
  );
}
