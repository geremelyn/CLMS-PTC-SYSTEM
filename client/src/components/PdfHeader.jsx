import './PdfHeader.css';
import { PDF_HEADER } from '../utils/pdfHeader.js';

/**
 * Reusable PDF header: PTC logo (left) | college text (center) | ICCT logo (right).
 * Use inside any printable/PDF view. Page size is set by PDF_PAGE_CSS in utils/pdfHeader.js.
 */
export default function PdfHeader() {
  return (
    <header className="clms-pdf-header">
      <img className="clms-pdf-header__logo" src={PDF_HEADER.leftLogo} alt="Pateros Technological College logo" />
      <div className="clms-pdf-header__text">
        <p className="clms-pdf-header__college">{PDF_HEADER.college}</p>
        <p className="clms-pdf-header__address">{PDF_HEADER.address}</p>
        <p className="clms-pdf-header__institute">{PDF_HEADER.institute}</p>
      </div>
      <img className="clms-pdf-header__logo" src={PDF_HEADER.rightLogo} alt="Institute of Information and Computing Technology logo" />
    </header>
  );
}
