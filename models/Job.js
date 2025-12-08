import mongoose from 'mongoose';

const jobSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  prompt: {
    type: String,
    required: true,
  },
  negativePrompt: {
    type: String,
  },
  model: {
    type: String,
    default: 'stabilityai/stable-diffusion-xl-base-1.0',
  },
  parameters: {
    width: Number,
    height: Number,
  },
  status: {
    type: String,
    enum: ['pending', 'processing', 'completed', 'failed'],
    default: 'pending',
  },
  result: {
    images: [{
      url: String,
      width: Number,
      height: Number,
      filename: String,
    }],
    timeTaken: Number,
    model: String,
    note: String,
  },
  error: {
    message: String,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

export default mongoose.model('Job', jobSchema);
