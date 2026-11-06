export function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

export function shortTaskLabel(taskCard) {
  const name = taskCard.split("/").pop() ?? "task";
  return `task:${name.replace(/\.md$/i, "").slice(0, 40)}`;
}
