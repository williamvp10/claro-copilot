export function MessageText({ text }: { text: string }) {
  return text.split(/(\r?\n)/).map((line, index) => {
    if (!/^https?:\/\/[^\s]+$/i.test(line)) return line;
    try {
      const url = new URL(line);
      if (url.username || url.password) return line;
      return <a key={index} href={url.href} target="_blank" rel="noreferrer">{line}</a>;
    } catch {
      return line;
    }
  });
}
