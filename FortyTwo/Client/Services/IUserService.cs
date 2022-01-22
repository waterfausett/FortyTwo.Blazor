using FortyTwo.Shared.DTO;
using System.Collections.Generic;
using System.Threading.Tasks;

namespace FortyTwo.Client.Services
{
    public interface IUserService
    {
        /// <summary>
        /// Syncs unknown users into the <see cref="FortyTwo.Client.Store.IClientStore"/>
        /// </summary>
        /// <remarks>Any <paramref name="userIds"/> that are already in the store will be ignored.</remarks>
        /// <param name="userIds"></param>
        /// <returns></returns>
        Task SyncUsersAsync(List<string> userIds);
        Task<List<User>> FetchUsersAsync(List<string> userIds);
        Task<User> FetchProfileAsync();
        Task<bool> UpdateDisplayName(string displayName);
        string GetUserName(string userId);
    }
}
