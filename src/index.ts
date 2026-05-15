import express from 'express';
import dotenv from 'dotenv';
import jobRoutes from './routes/jobRoutes';
import './workers'; // Initialize worker process
import { logger } from './utils/logger';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.use((req, res, next) => {
  logger.info(`Incoming Request: ${req.method} ${req.url}`);
  next();
});

app.use('/api', jobRoutes);

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  logger.error('Unhandled express error:', { error: err.message, stack: err.stack });
  if (err instanceof Error) {
    return res.status(400).json({ error: err.message });
  }
  res.status(500).json({ error: 'Something went wrong' });
});

app.listen(PORT, () => {
  logger.info(`Server is running on port ${PORT}`);
});
