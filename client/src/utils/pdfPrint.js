// CP34 - Opens a generated Letter-size HTML document in a hidden iframe and calls print()
// so the browser's "Save as PDF" destination produces the PDF. No server or new dependency needed.
export function printHtmlDocument(html) {
  return new Promise((resolve, reject) => {
    const iframe = document.createElement('iframe');
    iframe.setAttribute('aria-hidden', 'true');
    iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
    const cleanup = () => setTimeout(() => iframe.remove(), 1000);
    iframe.onload = async () => {
      try {
        const win = iframe.contentWindow;
        const doc = iframe.contentDocument;
        // Wait until both logos are decoded so the header is never printed blank.
        await Promise.all([...doc.images].map(img => img.complete ? Promise.resolve() : new Promise(r => { img.onload = img.onerror = r; })));
        win.addEventListener('afterprint', cleanup, { once: true });
        win.focus();
        win.print();
        resolve();
      } catch (error) { cleanup(); reject(error); }
    };
    iframe.srcdoc = html;
    document.body.appendChild(iframe);
  });
}
