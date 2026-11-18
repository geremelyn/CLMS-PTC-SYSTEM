import api from '../api'

// Asks the server for an Excel file (built from database records) and saves it in the browser.
// Throws if the server refuses, so callers never show "export complete" for a failed export.
function saveBlobResponse(response, fallbackName) {
    const disposition = response.headers?.['content-disposition'] || ''
    const name = /filename="?([^";]+)"?/i.exec(disposition)?.[1] || fallbackName
    const url = URL.createObjectURL(response.data)
    const link = document.createElement('a')
    link.href = url
    link.download = name
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
    return name
}

export async function downloadExcel(endpoint, body, fallbackName) {
    const response = await api.post(endpoint, body, { responseType: 'blob' })
    return saveBlobResponse(response, fallbackName)
}

// Downloads the server-built import template (GET <module>/import-template). Read-only.
export async function downloadTemplate(endpoint, fallbackName = 'CLMS_Import_Template.xlsx') {
    const response = await api.get(endpoint, { responseType: 'blob' })
    return saveBlobResponse(response, fallbackName)
}

// Blob error responses hide the JSON message; this reads it back for display.
export async function exportErrorMessage(error, fallback) {
    try {
        const blob = error.response?.data
        if (blob instanceof Blob) return JSON.parse(await blob.text()).message || fallback
    } catch { /* not JSON */ }
    return error.response?.data?.message || fallback
}
