import express from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
import { HfInference } from '@huggingface/inference';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import User from './models/User.js';
import Job from './models/Job.js';
import ApiKey from './models/ApiKey.js';
import Transaction from './models/Transaction.js';
import { authenticate, generateToken } from './middleware/auth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '.env') });

const app = express();
const PORT = process.env.PORT || 3000;
const HF_API_KEY = process.env.HUGGINGFACE_API_KEY || '';
const hf = HF_API_KEY ? new HfInference(HF_API_KEY) : null;

const DB_URL = process.env.DB_URL;
if (!DB_URL) {
  console.error('❌ DB_URL not found in .env file');
  process.exit(1);
}

mongoose.connect(DB_URL, {
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 45000,
})
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => {
    console.error('❌ MongoDB connection error:', err.message);
    console.error('⚠️  Please check:');
    console.error('   1. MongoDB Atlas cluster is running');
    console.error('   2. Network access is configured (IP whitelist)');
    console.error('   3. Database credentials are correct');
    console.error('   4. Internet connection is stable');
    process.exit(1);
  });

const imagesDir = path.join(__dirname, 'generated-images');
if (!fs.existsSync(imagesDir)) {
  fs.mkdirSync(imagesDir, { recursive: true });
}

app.use(cors());
app.use(express.json());
app.use('/generated-images', express.static(imagesDir));

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    huggingface: HF_API_KEY ? 'connected' : 'not configured',
    database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
  });
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, firstName, lastName } = req.body;
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ error: 'Email already registered' });
    }
    const user = new User({ email, password, firstName, lastName, credits: 100 });
    await user.save();
    await Transaction.create({
      userId: user._id,
      type: 'bonus',
      amount: 0,
      credits: 100,
      description: 'Welcome bonus credits',
    });
    const accessToken = generateToken(user._id);
    res.status(201).json({ 
      user: {
        id: user._id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        credits: user.credits,
        createdAt: user.createdAt,
      }, 
      accessToken 
    });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const accessToken = generateToken(user._id);
    res.json({ 
      user: {
        id: user._id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        credits: user.credits,
        createdAt: user.createdAt,
      }, 
      accessToken 
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.get('/api/users/me', authenticate, async (req, res) => {
  try {
    res.json({
      id: req.user._id,
      email: req.user.email,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      credits: req.user.credits,
      createdAt: req.user.createdAt,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

app.get('/api/analytics/stats', authenticate, async (req, res) => {
  try {
    const userId = req.user._id;
    const totalImages = await Job.countDocuments({ userId, status: 'completed' });
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);
    const imagesThisMonth = await Job.countDocuments({
      userId,
      status: 'completed',
      createdAt: { $gte: startOfMonth }
    });
    const usageTransactions = await Transaction.find({ userId, type: 'usage' });
    const totalCreditsUsed = usageTransactions.reduce((sum, t) => sum + Math.abs(t.credits), 0);
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const recentJobs = await Job.find({
      userId,
      createdAt: { $gte: sevenDaysAgo }
    }).sort({ createdAt: -1 }).limit(10);
    res.json({
      totalImages,
      imagesThisMonth,
      totalCreditsUsed,
      currentCredits: req.user.credits,
      recentActivity: recentJobs.map(job => ({
        id: job._id,
        prompt: job.prompt,
        status: job.status,
        createdAt: job.createdAt,
      }))
    });
  } catch (error) {
    console.error('Analytics error:', error);
    res.status(500).json({ error: 'Failed to fetch analytics' });
  }
});

app.post('/api/images/generate', authenticate, async (req, res) => {
  try {
    const { prompt, model, parameters, negativePrompt } = req.body;
    if (!prompt) {
      return res.status(400).json({ error: 'Prompt is required' });
    }
    if (req.user.credits < 1) {
      return res.status(402).json({ error: 'Insufficient credits' });
    }
    const job = new Job({
      userId: req.user._id,
      prompt,
      negativePrompt,
      model: model || 'stabilityai/stable-diffusion-xl-base-1.0',
      parameters,
      status: 'pending',
    });
    await job.save();
    req.user.credits -= 1;
    await req.user.save();
    await Transaction.create({
      userId: req.user._id,
      type: 'usage',
      amount: 0,
      credits: -1,
      description: `Image generation: ${prompt.substring(0, 50)}...`,
      metadata: { jobId: job._id }
    });
    processImageGeneration(job._id.toString());
    res.status(202).json({ jobId: job._id, status: 'pending' });
  } catch (error) {
    console.error('Generate error:', error);
    res.status(500).json({ error: 'Failed to create job' });
  }
});

async function processImageGeneration(jobId) {
  try {
    const job = await Job.findById(jobId);
    if (!job) return;
    job.status = 'processing';
    await job.save();
    if (!hf || !HF_API_KEY) {
      console.log('⚠️  No HuggingFace API key - using placeholder');
      job.status = 'completed';
      job.result = {
        images: [{
          url: `https://picsum.photos/seed/${jobId}/${job.parameters?.width || 1024}/${job.parameters?.height || 1024}`,
          width: job.parameters?.width || 1024,
          height: job.parameters?.height || 1024,
        }],
        timeTaken: 1000,
        note: 'Add HUGGINGFACE_API_KEY to .env for real generation',
      };
      await job.save();
      return;
    }
    console.log(`🎨 Generating: "${job.prompt}"`);
    const startTime = Date.now();
    let modelId = 'black-forest-labs/FLUX.1-schnell';
    if (job.model === 'dalle-3') {
      modelId = 'black-forest-labs/FLUX.1-schnell';
    } else if (job.model === 'midjourney') {
      modelId = 'prompthero/openjourney-v4';
    } else if (job.model === 'stability-sd-3') {
      modelId = 'stabilityai/stable-diffusion-2-1';
    }
    let imageBlob;
    let retries = 3;
    let lastError;
    while (retries > 0) {
      try {
        console.log(`🔄 Attempt ${4 - retries}/3 with model: ${modelId}`);
        imageBlob = await Promise.race([
          hf.textToImage({
            model: modelId,
            inputs: job.prompt,
            parameters: { negative_prompt: job.negativePrompt || '' }
          }),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Request timeout after 60s')), 60000)
          )
        ]);
        break;
      } catch (err) {
        lastError = err;
        retries--;
        console.log(`⚠️  Attempt failed: ${err.message}. Retries left: ${retries}`);
        if (retries > 0) {
          if (modelId === 'black-forest-labs/FLUX.1-schnell') {
            modelId = 'stabilityai/stable-diffusion-2-1';
          } else if (modelId === 'stabilityai/stable-diffusion-2-1') {
            modelId = 'runwayml/stable-diffusion-v1-5';
          }
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }
    }
    if (!imageBlob) {
      throw lastError || new Error('Failed to generate image after retries');
    }
    const buffer = Buffer.from(await imageBlob.arrayBuffer());
    const filename = `image-${jobId}-${Date.now()}.png`;
    const filepath = path.join(imagesDir, filename);
    fs.writeFileSync(filepath, buffer);
    const timeTaken = Date.now() - startTime;
    job.status = 'completed';
    // Use environment variable for base URL or fallback to localhost
    const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;
    
    job.result = {
      images: [{
        url: `${baseUrl}/generated-images/${filename}`,
        width: job.parameters?.width || 1024,
        height: job.parameters?.height || 1024,
        filename,
      }],
      timeTaken,
      model: modelId,
    };
    await job.save();
    console.log(`✅ Generated in ${timeTaken}ms using ${modelId}`);
  } catch (error) {
    console.error('❌ Generation failed:', error.message);
    const job = await Job.findById(jobId);
    if (job) {
      job.status = 'failed';
      job.error = { message: error.message || 'Image generation failed' };
      await job.save();
      const user = await User.findById(job.userId);
      if (user) {
        user.credits += 1;
        await user.save();
        await Transaction.create({
          userId: user._id,
          type: 'refund',
          amount: 0,
          credits: 1,
          description: 'Refund for failed generation',
          metadata: { jobId: job._id }
        });
      }
    }
  }
}

app.get('/api/images/jobs/:id', authenticate, async (req, res) => {
  try {
    const job = await Job.findOne({ _id: req.params.id, userId: req.user._id });
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }
    res.json({
      id: job._id,
      prompt: job.prompt,
      model: job.model,
      parameters: job.parameters,
      status: job.status,
      result: job.result,
      error: job.error,
      createdAt: job.createdAt,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch job' });
  }
});

app.get('/api/images/jobs', authenticate, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;
    const jobs = await Job.find({ userId: req.user._id })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);
    const total = await Job.countDocuments({ userId: req.user._id });
    res.json({
      jobs: jobs.map(job => ({
        id: job._id,
        prompt: job.prompt,
        model: job.model,
        status: job.status,
        result: job.result,
        createdAt: job.createdAt,
      })),
      pagination: { page, limit, total },
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch jobs' });
  }
});

app.get('/api/images/gallery', authenticate, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;
    const jobs = await Job.find({ userId: req.user._id, status: 'completed' })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);
    const total = await Job.countDocuments({ userId: req.user._id, status: 'completed' });
    res.json({
      images: jobs.map(job => ({
        id: job._id,
        prompt: job.prompt,
        result: job.result,
        createdAt: job.createdAt,
      })),
      pagination: { page, limit, total },
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch gallery' });
  }
});

app.get('/api/billing/packages', (req, res) => {
  res.json({
    packages: [
      { id: 'starter', name: 'Starter Pack', credits: 50, price: 9.99, popular: false },
      { id: 'pro', name: 'Pro Pack', credits: 200, price: 29.99, popular: true, bonus: 20 },
      { id: 'ultimate', name: 'Ultimate Pack', credits: 500, price: 59.99, popular: false, bonus: 100 },
    ]
  });
});

app.post('/api/billing/purchase', authenticate, async (req, res) => {
  try {
    const { packageId, paymentMethod } = req.body;
    const packages = {
      starter: { credits: 50, price: 9.99 },
      pro: { credits: 220, price: 29.99 },
      ultimate: { credits: 600, price: 59.99 },
    };
    const pkg = packages[packageId];
    if (!pkg) {
      return res.status(400).json({ error: 'Invalid package' });
    }
    req.user.credits += pkg.credits;
    await req.user.save();
    await Transaction.create({
      userId: req.user._id,
      type: 'purchase',
      amount: pkg.price,
      credits: pkg.credits,
      description: `Purchased ${packageId} package`,
      metadata: { packageId, paymentMethod }
    });
    res.json({
      success: true,
      newBalance: req.user.credits,
      creditsAdded: pkg.credits,
    });
  } catch (error) {
    console.error('Purchase error:', error);
    res.status(500).json({ error: 'Purchase failed' });
  }
});

app.get('/api/billing/transactions', authenticate, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;
    const transactions = await Transaction.find({ userId: req.user._id })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);
    const total = await Transaction.countDocuments({ userId: req.user._id });
    res.json({
      transactions: transactions.map(t => ({
        id: t._id,
        type: t.type,
        amount: t.amount,
        credits: t.credits,
        description: t.description,
        status: t.status,
        createdAt: t.createdAt,
      })),
      pagination: { page, limit, total },
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch transactions' });
  }
});

app.get('/api/keys', authenticate, async (req, res) => {
  try {
    const keys = await ApiKey.find({ userId: req.user._id }).sort({ createdAt: -1 });
    res.json({
      keys: keys.map(k => ({
        id: k._id,
        name: k.name,
        key: k.key.substring(0, 12) + '...' + k.key.substring(k.key.length - 4),
        fullKey: k.key,
        lastUsed: k.lastUsed,
        usageCount: k.usageCount,
        isActive: k.isActive,
        createdAt: k.createdAt,
      }))
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch API keys' });
  }
});

app.post('/api/keys', authenticate, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'Name is required' });
    }
    const key = ApiKey.generateKey();
    const apiKey = new ApiKey({ userId: req.user._id, name, key });
    await apiKey.save();
    res.status(201).json({
      id: apiKey._id,
      name: apiKey.name,
      key: apiKey.key,
      createdAt: apiKey.createdAt,
    });
  } catch (error) {
    console.error('Create API key error:', error);
    res.status(500).json({ error: 'Failed to create API key' });
  }
});

app.delete('/api/keys/:id', authenticate, async (req, res) => {
  try {
    const apiKey = await ApiKey.findOne({ _id: req.params.id, userId: req.user._id });
    if (!apiKey) {
      return res.status(404).json({ error: 'API key not found' });
    }
    await ApiKey.deleteOne({ _id: req.params.id });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete API key' });
  }
});

app.patch('/api/keys/:id/toggle', authenticate, async (req, res) => {
  try {
    const apiKey = await ApiKey.findOne({ _id: req.params.id, userId: req.user._id });
    if (!apiKey) {
      return res.status(404).json({ error: 'API key not found' });
    }
    apiKey.isActive = !apiKey.isActive;
    await apiKey.save();
    res.json({ success: true, isActive: apiKey.isActive });
  } catch (error) {
    res.status(500).json({ error: 'Failed to toggle API key' });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 API server running on http://localhost:${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/health`);
  console.log(`\n🤗 HuggingFace: ${HF_API_KEY ? '✅ Connected' : '⚠️  Not configured'}`);
  if (!HF_API_KEY) {
    console.log(`\n💡 To enable real AI image generation:`);
    console.log(`   1. Get API key: https://huggingface.co/settings/tokens`);
    console.log(`   2. Add to .env: HUGGINGFACE_API_KEY=your_key_here`);
    console.log(`   3. Restart server\n`);
  }
  console.log(`🗄️  Production mode - MongoDB storage`);
});
