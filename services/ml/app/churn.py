"""Input and feature preparation for the 90-day churn logistic regression."""
from datetime import date
from typing import Annotated, Literal

import numpy as np
import pandas as pd
from pydantic import BaseModel, ConfigDict, Field, model_validator

from .common import LABELS

HISTORY_CATEGORIES = [*sorted(LABELS), "categoria_no_disponible"]
CATEGORICAL = ["ciudad", "tipo_servicio", "plan_hogar", "plan_movil", "metodo_pago"]
NUMERIC = [
    "valor_mensual", "antiguedad_meses", "dias_mora", "tickets_90d", "tickets_tecnicos_90d",
    "caidas_servicio_90d", "consumo_log", "nps_ultimo", "ofertas_retencion_12m",
]
HISTORY_COLUMNS = [
    f"{category}_ultimos_{days}d" for days in (30, 90) for category in HISTORY_CATEGORIES
]
FEATURE_NAMES = [*CATEGORICAL, *NUMERIC, *HISTORY_COLUMNS, "dias_desde_ultimo_ticket"]

Count = Annotated[int, Field(strict=True, ge=0)]
Measure = Annotated[float, Field(strict=True, ge=0, allow_inf_nan=False)]
Category = Annotated[str, Field(min_length=1, max_length=100)]


class TicketCounts(BaseModel):
    model_config = ConfigDict(extra="forbid")

    cancelacion: Count
    consulta_planes: Count
    facturacion: Count
    portabilidad: Count
    soporte_tecnico: Count
    categoria_no_disponible: Count


class ChurnPrediction(BaseModel):
    model_config = ConfigDict(extra="forbid")

    fecha_corte: date
    ciudad: Category | None = None
    tipo_servicio: Literal["hogar", "movil", "convergente"]
    plan_hogar: Category | None = None
    plan_movil: Category | None = None
    metodo_pago: Category
    valor_mensual: Measure
    antiguedad_meses: Count | None
    dias_mora: Count
    tickets_90d: Count
    tickets_tecnicos_90d: Count
    caidas_servicio_90d: Count | None
    uso_datos_gb_mes: Measure | None
    nps_ultimo: Annotated[int, Field(strict=True, ge=0, le=10)] | None
    ofertas_retencion_12m: Annotated[int, Field(strict=True, ge=0, le=1)]
    historial_30d: TicketCounts
    historial_90d: TicketCounts
    dias_desde_ultimo_ticket: Annotated[float, Field(strict=True, gt=0, allow_inf_nan=False)] | None

    @model_validator(mode="after")
    def check_history(self):
        short, long = self.historial_30d.model_dump(), self.historial_90d.model_dump()
        if sum(long.values()) != self.tickets_90d or self.tickets_tecnicos_90d > self.tickets_90d:
            raise ValueError("inconsistent 90-day ticket totals")
        if any(short[key] > long[key] for key in short):
            raise ValueError("30-day history exceeds 90-day history")
        days = self.dias_desde_ultimo_ticket
        if bool(self.tickets_90d) != (days is not None and days <= 90):
            raise ValueError("last ticket date does not match the 90-day history")
        if bool(sum(short.values())) != (days is not None and days <= 30):
            raise ValueError("last ticket date does not match the 30-day history")
        return self

    def as_frame(self) -> pd.DataFrame:
        fields = self.model_dump(exclude={"fecha_corte", "historial_30d", "historial_90d"})
        for days in (30, 90):
            counts = getattr(self, f"historial_{days}d").model_dump()
            fields.update({f"{category}_ultimos_{days}d": count for category, count in counts.items()})
        return churn_features(pd.DataFrame([fields]))


def churn_features(frame: pd.DataFrame) -> pd.DataFrame:
    usage = frame["uso_datos_gb_mes"].astype(float)
    prepared = frame.assign(consumo_log=np.log1p(usage.where(usage.ge(0))))[FEATURE_NAMES].copy()
    prepared["antiguedad_meses"] = prepared["antiguedad_meses"].where(prepared["antiguedad_meses"].ge(0))
    has_home = prepared["tipo_servicio"].isin(["hogar", "convergente"])
    has_mobile = prepared["tipo_servicio"].isin(["movil", "convergente"])
    prepared.loc[~has_home, "plan_hogar"] = "__no_aplica__"
    prepared.loc[~has_mobile, "plan_movil"] = "__no_aplica__"
    prepared.loc[~has_home, "caidas_servicio_90d"] = np.nan
    prepared.loc[~has_mobile, "consumo_log"] = np.nan
    prepared[CATEGORICAL] = prepared[CATEGORICAL].fillna("__sin_dato__").astype(str)
    columns = [name for name in FEATURE_NAMES if name not in CATEGORICAL]
    prepared[columns] = prepared[columns].astype(float)
    return prepared
