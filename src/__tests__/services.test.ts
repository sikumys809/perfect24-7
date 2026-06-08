// サービス層のユニットテスト雛形

import { Logger } from '../../utils/logger';

describe('Logger', () => {
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('should log info message', () => {
    const message = 'Test info message';
    Logger.info(message);
    expect(console.log).toHaveBeenCalled();
  });

  test('should log error message with error object', () => {
    const message = 'Test error';
    const error = new Error('Something went wrong');
    Logger.error(message, error);
    expect(console.log).toHaveBeenCalled();
  });

  test('should log debug message with data', () => {
    const message = 'Test debug';
    const data = { userId: '123', action: 'fetch' };
    Logger.debug(message, data);
    expect(console.log).toHaveBeenCalled();
  });
});

// サービス層のテスト例（実装時にここに追加）
describe('Services (Integration Tests - Placeholder)', () => {
  test('should initialize supabase client', () => {
    // TODO: supabase.getSupabaseClient() をテスト
  });

  test('should fetch user by LINE ID', () => {
    // TODO: supabase.getUserByLineId() をテスト
  });

  test('should analyze receipt image', () => {
    // TODO: llm.analyzeReceiptImage() をテスト
  });
});
