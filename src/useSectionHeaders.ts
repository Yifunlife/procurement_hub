import { useEffect } from "react";

// Horizontal overflow containers prevent CSS sticky from following the outer
// vertical scroller. Translate only table heads, retaining native column widths.
export function useSectionHeaders() {
  useEffect(() => {
    let frame = 0;
    const offsets = new Map<HTMLElement, number>();
    function update() {
      frame = 0;
      const heads = document.querySelectorAll<HTMLElement>(".product-workflow-head, .finance-table thead, .catalog-head, .supplier-head");
      for (const head of heads) {
        if (!head.getClientRects().length) continue;
        const table = head.parentElement!;
        const rect = head.getBoundingClientRect();
        let ancestor = table.parentElement;
        let top = 0;
        while (ancestor) {
          const style = getComputedStyle(ancestor);
          if (/(auto|scroll)/.test(style.overflowY) && ancestor.scrollHeight > ancestor.clientHeight + 1) {
            top = ancestor.getBoundingClientRect().top + ancestor.clientTop;
            break;
          }
          ancestor = ancestor.parentElement;
        }
        const section = head.closest(".detail-section");
        const heading = section?.querySelector<HTMLElement>(":scope > .section-heading, :scope > h3");
        if (heading) top = Math.max(top, heading.getBoundingClientRect().bottom);
        const naturalTop = rect.top - (offsets.get(head) || 0);
        const offset = Math.max(0, Math.min(top - naturalTop, table.getBoundingClientRect().bottom - rect.height - naturalTop));
        offsets.set(head, offset);
        head.style.transform = offset ? `translateY(${offset}px)` : "";
      }
      for (const head of offsets.keys()) if (!head.isConnected) offsets.delete(head);
    }
    function schedule() { if (!frame) frame = requestAnimationFrame(update); }
    document.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden", "open"] });
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
      observer.disconnect();
      for (const head of offsets.keys()) head.style.transform = "";
    };
  }, []);
}
