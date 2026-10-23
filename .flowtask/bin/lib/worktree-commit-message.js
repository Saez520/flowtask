export function composeClosureMessage({ workId, title, body } = {}) {
  const id = String(workId ?? "");
  const normalizedTitle = typeof title === "string" ? title.replace(/\r\n|\r|\u0000/g, " ").replace(/\s+/g, " ").trim() : "";
  let subject;
  if (!normalizedTitle) {
    subject = `Cierre generico de ${id}`;
  } else if (normalizedTitle.includes(id) && id) {
    subject = normalizedTitle;
  } else {
    subject = `${normalizedTitle} [${id}]`;
  }
  let finalBody;
  if (!normalizedTitle) {
    finalBody = "No habia una descripcion de la entrega disponible al momento del cierre.";
  } else {
    finalBody = typeof body === "string" ? body.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").map((line) => line.replace(/[ \t]+$/g, "")).join("\n").replace(/\n+$/g, "") : "";
  }
  return { subject, body: finalBody };
}
