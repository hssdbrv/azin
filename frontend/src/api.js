import axios from "axios";

export const API_BASE_URL = import.meta.env.VITE_API_URL || (
  typeof window !== "undefined"
    ? `${window.location.protocol}//${window.location.hostname}:4000`
    : "http://localhost:4000"
);

export const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: 15000,
});
