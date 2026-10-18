import type { ConnectorStatus, IngestEntry } from '@payblink/shared';
import type { InvoiceInput } from '../core/types';
import { loadInvoicesFromDisk } from '../storage/load-invoices';
import {
  folderSourceInfo,
  hashFolderInvoice,
  normalizeEntry,
  type NormalizedInvoice,
} from './normalize';

/** RF-1.4: toda fuente de facturas implementa esta interfaz. */
export interface InvoiceSource {
  readonly id: string;
  readonly nombre: string;
  readonly descripcion: string;
  readonly estado: ConnectorStatus;
  /** Devuelve facturas ya normalizadas, con fuente e idempotencia por hash. */
  pull(): Promise<NormalizedInvoice[]>;
}

/** RF-1.5: lee las facturas simuladas de `data/invoices/`. */
export class FolderSource implements InvoiceSource {
  readonly id = 'carpeta-demo';
  readonly nombre = 'Carpeta de demo';
  readonly descripcion = 'Lee data/invoices y crea facturas pendientes.';
  readonly estado: ConnectorStatus = 'activo';

  async pull(): Promise<NormalizedInvoice[]> {
    const facturas = await loadInvoicesFromDisk();
    const recibidoEn = new Date().toISOString();
    return facturas.map((invoice: InvoiceInput) => ({
      invoice,
      source: folderSourceInfo(invoice, recibidoEn),
      hash: hashFolderInvoice(invoice),
    }));
  }
}

/** RF-1.5: entradas creadas desde la pantalla Entradas. */
export class SimulatedSource implements InvoiceSource {
  readonly id = 'simulador';
  readonly nombre = 'Simulador de entradas';
  readonly descripcion = 'Normaliza PDF, correo o mensaje de chat creados en la UI.';
  readonly estado: ConnectorStatus = 'activo';

  constructor(private readonly entry: IngestEntry) {}

  async pull(): Promise<NormalizedInvoice[]> {
    return [await normalizeEntry(this.entry)];
  }
}
