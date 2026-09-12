import mongoose from 'mongoose';
import { registerObjectIdType } from '@simtlix/simfinity-core/internal/object-id';

registerObjectIdType(
  mongoose.Types.ObjectId,
  mongoose.Types.ObjectId.prototype.toHexString,
);
