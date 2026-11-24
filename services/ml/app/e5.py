"""Pinned multilingual E5 encoder and the linear SVM used by the intent experiment."""
import hashlib
from pathlib import Path

import numpy as np

ENCODER_REVISION = "614241f622f53c4eeff9890bdc4f31cfecc418b3"
ENCODER_FILES = {
    "model.onnx": "ca456c06b3a9505ddfd9131408916dd79290368331e7d76bb621f1cba6bc8665",
    "tokenizer.json": "0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39",
}
EMBEDDING_SIZE = 384


class E5Encoder:
    def __init__(self, path: Path):
        import onnxruntime as ort
        from tokenizers import Tokenizer

        for name, checksum in ENCODER_FILES.items():
            with (path / name).open("rb") as stream:
                if hashlib.file_digest(stream, "sha256").hexdigest() != checksum:
                    raise ValueError(f"E5 checksum mismatch for {name}")

        self.tokenizer = Tokenizer.from_file(str(path / "tokenizer.json"))
        self.tokenizer.enable_truncation(max_length=512)
        self.tokenizer.enable_padding(pad_id=self.tokenizer.token_to_id("<pad>"), pad_token="<pad>")
        options = ort.SessionOptions()
        options.intra_op_num_threads = 2
        options.inter_op_num_threads = 1
        self.session = ort.InferenceSession(
            str(path / "model.onnx"), options, providers=["CPUExecutionProvider"]
        )
        self.input_names = {item.name for item in self.session.get_inputs()}

    def encode(self, texts: list[str], kind: str = "query") -> np.ndarray:
        if kind not in ("query", "passage"):
            raise ValueError("Unsupported embedding task")
        unique = list(dict.fromkeys(texts))
        vectors = {}
        for offset in range(0, len(unique), 16):
            batch = unique[offset:offset + 16]
            tokens = self.tokenizer.encode_batch([f"{kind}: {text}" for text in batch])
            inputs = {
                "input_ids": np.array([item.ids for item in tokens], dtype=np.int64),
                "attention_mask": np.array([item.attention_mask for item in tokens], dtype=np.int64),
                "token_type_ids": np.array([item.type_ids for item in tokens], dtype=np.int64),
            }
            hidden, = self.session.run(
                ["last_hidden_state"], {key: inputs[key] for key in self.input_names}
            )
            mask = inputs["attention_mask"][..., None]
            pooled = (hidden * mask).sum(axis=1, dtype=np.float32) / mask.sum(axis=1, dtype=np.float32)
            pooled /= np.linalg.norm(pooled, axis=1, keepdims=True)
            vectors.update(zip(batch, pooled))
        return np.stack([vectors[text] for text in texts])


def svm_scores(classifier, embeddings):
    """Monotone score of the margin between the first and second classes."""
    margins = classifier.decision_function(embeddings)
    winners = margins.argmax(axis=1)
    best_two = np.sort(margins, axis=1)[:, -2:]
    gap = best_two[:, 1] - best_two[:, 0]
    return classifier.classes_[winners], -np.expm1(-gap)


class E5Intent:
    def __init__(self, classifier, encoder: E5Encoder):
        self.classifier = classifier
        self.encoder = encoder

    def predict_one(self, text: str) -> tuple[str, float]:
        labels, scores = svm_scores(self.classifier, self.encoder.encode([text]))
        return str(labels[0]), float(scores[0])
