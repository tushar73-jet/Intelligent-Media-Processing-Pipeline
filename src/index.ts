import express, { Request, Response, NextFunction } from 'express';
import dotenv from 'dotenv';
import jobRoutes from './routes/jobRoutes';
import './workers'; // Start the BullMQ worker in the same process (see workers/index.ts)
import { logger } from './utils/logger';

dotenv.config();

const app  = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((req: Request, _res: Response, next: NextFunction) => {
  logger.info('Incoming request', { method: req.method, url: req.url });
  next();
});

app.use('/api', jobRoutes);

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Route not found' });
});

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  logger.error('Unhandled Express error', { error: err.message, stack: err.stack });
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`, { env: process.env.NODE_ENV });
});

export default app;