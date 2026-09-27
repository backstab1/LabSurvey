import { Component, type ReactNode } from 'react';

/**
 * Предохранитель: ошибка в одном экране не превращает страницу в белый лист.
 * Показывает, что случилось, и даёт перезагрузить; данные анкеты при этом не теряются (черновик уже на сервере).
 */
export class ErrorBoundary extends Component<{ children: ReactNode; title?: string }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    // Видно в консоли и в сквозных тестах
    console.error('SurveyLAB: ошибка интерфейса', error);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="crash" role="alert">
        <h2>{this.props.title ?? 'Что-то пошло не так'}</h2>
        <p>Экран не удалось показать из-за ошибки. Обновите страницу; если ошибка повторяется — сообщите разработчикам текст ниже.</p>
        <pre>{error.message}</pre>
        <button className="btn btn-primary" onClick={() => window.location.reload()}>Обновить страницу</button>
      </div>
    );
  }
}
