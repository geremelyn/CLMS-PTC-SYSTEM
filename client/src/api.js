import axios from 'axios'

// All frontend API calls use this single base URL. Individual pages should
// request paths such as /users or /reservations (without repeating /api).
const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || 'http://localhost:5000/api',
  timeout: 15000,
  headers: { 'Content-Type': 'application/json' }
})

api.interceptors.request.use((config) => {
  try {
    const raw = localStorage.getItem('user')
    const user = raw ? JSON.parse(raw) : null
    if (user?.token) {
      config.headers = config.headers || {}
      config.headers.Authorization = `Bearer ${user.token}`
    }
  } catch {
    localStorage.removeItem('user')
  }
  return config
})

api.interceptors.response.use(
  response => response,
  error => {
    if (error?.response?.status === 401) {
      const message = String(error.response?.data?.message || '').toLowerCase()
      if (message.includes('authentication required') || message.includes('session is invalid')) {
        localStorage.removeItem('user')
        if (typeof window !== 'undefined' && window.location.pathname !== '/') window.location.assign('/')
      }
    }
    return Promise.reject(error)
  }
)

export async function logoutSession() {
  try {
    await api.post('/auth/logout')
  } catch {
    // Clear the local session even if the server is unreachable.
  } finally {
    localStorage.removeItem('user')
  }
}

export default api
