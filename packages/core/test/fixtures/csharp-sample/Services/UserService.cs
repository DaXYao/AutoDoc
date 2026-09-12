using System;
using System.ComponentModel;

namespace SampleApp.Services
{
    /// <summary>
    /// 用户服务：负责用户数据的加载与校验。
    /// </summary>
    [Description("User service")]
    public class UserService
    {
        private readonly IRepository _repo;

        public UserService(IRepository repo)
        {
            // 保存依赖
            _repo = repo;
        }

        /// <summary>
        /// 分页拉取用户列表。
        /// </summary>
        /// <param name="page">页码，从 1 开始</param>
        public User[] ListUsers(int page)
        {
            // 参数校验
            if (page < 1) throw new ArgumentOutOfRangeException(nameof(page));
            // 拉取原始数据
            var rows = _repo.Fetch(page);
            return rows;
        }

        [Obsolete("Use ListUsers")]
        private bool TryValidate(string name, out string reason)
        {
            reason = string.Empty;
            return !string.IsNullOrWhiteSpace(name);
        }

        public string DisplayName => ComputeName();

        private string ComputeName()
        {
            // 拼接显示名
            return "user-" + DateTime.Now.Ticks;
        }
    }

    public interface IRepository
    {
        User[] Fetch(int page);
    }

    public record User(int Id, string Name);
}
