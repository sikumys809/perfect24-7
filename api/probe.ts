import type { VercelRequest, VercelResponse } from '@vercel/node';
import { PROBE, probeAdd } from '../lib/probe';
export default function handler(_req: VercelRequest, res: VercelResponse) {
  res.status(200).json({ probe: PROBE, sum: probeAdd(40, 2) });
}
